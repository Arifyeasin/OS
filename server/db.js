// SQLite persistence using Node's built-in driver (no native deps required).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'data'), { recursive: true });

export const db = new DatabaseSync(join(root, 'data', 'engineeros.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'DEVELOPER',
  avatar_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  username          TEXT NOT NULL DEFAULT '',
  access_token      TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS organizations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'MEMBER',
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS departments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'MEMBER',
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'MEMBER',
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending',
  invited_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'DEVELOPER',
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS requirements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'functional',   -- functional | non-functional
  category    TEXT NOT NULL DEFAULT 'Functional', -- Functional | Performance | Security | ...
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'medium',       -- high | medium | low
  story       TEXT NOT NULL DEFAULT '',             -- user story
  acceptance  TEXT NOT NULL DEFAULT '',             -- JSON array of criteria
  quality     INTEGER NOT NULL DEFAULT 0,           -- 0-100 quality score
  issues      TEXT NOT NULL DEFAULT '[]',           -- JSON array of ambiguity warnings
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sprints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',        -- active | completed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sprint_id      INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'backlog',   -- backlog|todo|in_progress|review|done
  points         INTEGER NOT NULL DEFAULT 3,
  assignee_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE IF NOT EXISTS task_commits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_pull_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',
  url        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS task_tests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  run_url    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_deployments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  url        TEXT NOT NULL DEFAULT '',
  deployed_at TEXT
);

CREATE TABLE IF NOT EXISTS bugs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  severity   TEXT NOT NULL DEFAULT 'medium',        -- critical|high|medium|low
  status     TEXT NOT NULL DEFAULT 'open',          -- open|in_progress|resolved
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Add user GitHub profile identity and avatar fields
try { db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE users ADD COLUMN github_username TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE users ADD COLUMN github_token TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

// Add OAuth account token and username fields
try { db.exec("ALTER TABLE oauth_accounts ADD COLUMN username TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE oauth_accounts ADD COLUMN access_token TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

// Add new project context fields without rebuilding or losing existing data.
try { db.exec("ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE projects ADD COLUMN github_token TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

db.exec(`
CREATE TABLE IF NOT EXISTS github_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type   TEXT NOT NULL,   -- 'commit' | 'pr' | 'issue'
  item_id     TEXT NOT NULL,   -- SHA or PR# or Issue#
  item_title  TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL,   -- 'task' | 'requirement' | 'bug'
  target_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diagram_specs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  diagram_type    TEXT NOT NULL,
  source_code     TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '[]',
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS generated_diagrams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  diagram_type TEXT NOT NULL,
  svg_path     TEXT NOT NULL DEFAULT '',
  svg_content  TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Set default github_repo only for the seed EngineerOS project if empty
try {
  db.exec("UPDATE projects SET github_repo = 'arif-404-hub/OS' WHERE id = 1 AND (github_repo IS NULL OR github_repo = '')");
} catch {}

/** Run a SELECT and return all rows. */
export const all = (sql, ...args) => db.prepare(sql).all(...args);
/** Run a SELECT and return the first row (or undefined). */
export const get = (sql, ...args) => db.prepare(sql).get(...args);
/** Run an INSERT/UPDATE/DELETE and return { changes, lastInsertRowid }. */
export const run = (sql, ...args) => db.prepare(sql).run(...args);

export function log(projectId, userId, message) {
  run('INSERT INTO activity (project_id, user_id, message) VALUES (?, ?, ?)', projectId, userId, message);
}

