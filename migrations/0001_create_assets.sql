CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  etag TEXT NOT NULL,
  custom_metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'deleting')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX assets_created_at_idx ON assets (created_at DESC, id DESC);
CREATE INDEX assets_media_type_idx ON assets (media_type);
