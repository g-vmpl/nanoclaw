# v2.db Schema Reference

> Auto-generated from `sqlite3 data/v2.db ".schema"`. Re-run to refresh.

## Core Entity Tables

### `agent_groups`
```sql
CREATE TABLE agent_groups (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  folder         TEXT NOT NULL UNIQUE,
  agent_provider TEXT,
  created_at     TEXT NOT NULL
);
```

### `messaging_groups`
```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            TEXT NOT NULL,
  denied_at             TEXT,
  UNIQUE(channel_type, platform_id)
);
```

### `messaging_group_agents` (wirings)
```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  engage_mode            TEXT,
  engage_pattern         TEXT,
  sender_scope           TEXT,
  ignored_message_policy TEXT,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

### `users`
```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,   -- format: "<channel_type>:<handle>"
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

### `user_roles`
```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,                        -- 'owner' | 'admin'
  agent_group_id TEXT REFERENCES agent_groups(id),    -- NULL = global scope
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
```

### `agent_group_members`
```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### `user_dms`
```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

---

## Sessions

### `sessions`
```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
```

---

## Container Config

### `container_configs`
```sql
CREATE TABLE container_configs (
  agent_group_id          TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider                TEXT,
  model                   TEXT,
  effort                  TEXT,
  image_tag               TEXT,
  assistant_name          TEXT,
  max_messages_per_prompt INTEGER,
  skills                  TEXT NOT NULL DEFAULT '"all"',
  mcp_servers             TEXT NOT NULL DEFAULT '{}',
  packages_apt            TEXT NOT NULL DEFAULT '[]',
  packages_npm            TEXT NOT NULL DEFAULT '[]',
  additional_mounts       TEXT NOT NULL DEFAULT '[]',
  cli_scope               TEXT NOT NULL DEFAULT 'group',
  updated_at              TEXT NOT NULL
);
```

---

## Approvals & Pending

### `pending_approvals`
```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

### `pending_questions`
```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

### `pending_sender_approvals`
```sql
CREATE TABLE pending_sender_approvals (
  id                   TEXT PRIMARY KEY,
  messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity      TEXT NOT NULL,   -- "<channel_type>:<handle>"
  sender_name          TEXT,
  original_message     TEXT NOT NULL,   -- JSON InboundEvent
  approver_user_id     TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  title                TEXT NOT NULL DEFAULT '',
  options_json         TEXT NOT NULL DEFAULT '[]',
  UNIQUE(messaging_group_id, sender_identity)
);
CREATE INDEX idx_pending_sender_approvals_mg ON pending_sender_approvals(messaging_group_id);
```

### `pending_channel_approvals`
```sql
CREATE TABLE pending_channel_approvals (
  messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  original_message   TEXT NOT NULL,   -- JSON InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  options_json       TEXT NOT NULL DEFAULT '[]'
);
```

---

## Destinations

### `agent_destinations`
```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

---

## Unregistered Senders

### `unregistered_senders`
```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

---

## Chat SDK (bridge tables)

### `chat_sdk_kv`
```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
```

### `chat_sdk_subscriptions`
```sql
CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `chat_sdk_locks`
```sql
CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### `chat_sdk_lists`
```sql
CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

---

## System

### `schema_version`
```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_schema_version_name ON schema_version(name);
```

---

## Quick Query Examples

```bash
# All agent groups
sqlite3 data/v2.db "SELECT id, name, folder FROM agent_groups"

# All wirings (messaging group → agent group)
sqlite3 data/v2.db "SELECT mga.id, mg.channel_type, mg.platform_id, ag.name FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id=mga.messaging_group_id JOIN agent_groups ag ON ag.id=mga.agent_group_id"

# Active sessions
sqlite3 data/v2.db "SELECT id, agent_group_id, status, container_status, last_active FROM sessions WHERE status='active'"

# Users and roles
sqlite3 data/v2.db "SELECT u.id, u.display_name, ur.role, ur.agent_group_id FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id"

# Pending approvals
sqlite3 data/v2.db "SELECT approval_id, action, status, created_at FROM pending_approvals WHERE status='pending'"

# Container configs
sqlite3 data/v2.db "SELECT agent_group_id, provider, model, cli_scope FROM container_configs"
```
