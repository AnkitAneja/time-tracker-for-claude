// Each entry is one migration. Never edit a shipped entry; append a new one.
// All timestamps are milliseconds since the Unix epoch.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    project     TEXT,
    status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    session_id  TEXT PRIMARY KEY,
    cwd         TEXT,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    end_reason  TEXT,
    task_id     INTEGER REFERENCES tasks(id)
  );

  -- detail holds SessionStart source or SessionEnd reason. Prompt text is never stored.
  CREATE TABLE events (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    detail      TEXT,
    timestamp   INTEGER NOT NULL,
    task_id     INTEGER REFERENCES tasks(id)
  );
  CREATE INDEX idx_events_session ON events(session_id);

  CREATE TABLE time_records (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT,
    task_id     INTEGER REFERENCES tasks(id),
    kind        TEXT    NOT NULL,
    seconds     REAL    NOT NULL,
    timestamp   INTEGER NOT NULL
  );
  CREATE INDEX idx_time_records_timestamp ON time_records(timestamp);
  CREATE INDEX idx_time_records_task ON time_records(task_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Auto-named tasks. sessions.task_id now means "the task this session is about",
  // set by auto naming; NULL until the session is named.
  `
  ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto'));
  `,
  // Set when the user moves a session's latest time to another task by hand;
  // auto naming then leaves that session's task alone.
  `
  ALTER TABLE sessions ADD COLUMN task_locked INTEGER NOT NULL DEFAULT 0;
  `,
  // Cost, tokens, lines of code, commits and PRs, tagged with a task like time_records.
  // metric: cost (USD) | tokens | lines | commits | prs; kind: token type, added/removed, or ''.
  `
  CREATE TABLE usage_records (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT,
    task_id     INTEGER REFERENCES tasks(id),
    metric      TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT '',
    value       REAL    NOT NULL,
    timestamp   INTEGER NOT NULL
  );
  CREATE INDEX idx_usage_timestamp ON usage_records(timestamp);
  CREATE INDEX idx_usage_task ON usage_records(task_id);
  `
]
