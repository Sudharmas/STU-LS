PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('last_successful_sync_at', '');
INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('last_push_batch_size', '0');
INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('full_snapshot_seeded', '0');
