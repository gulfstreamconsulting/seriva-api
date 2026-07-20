CREATE TABLE IF NOT EXISTS accounts (
  id TEXT NOT NULL PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL,
  provider TEXT NOT NULL, providerAccountId TEXT NOT NULL, refresh_token TEXT,
  access_token TEXT, expires_at INTEGER, token_type TEXT, scope TEXT,
  id_token TEXT, session_state TEXT, oauth_token_secret TEXT, oauth_token TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_unique ON accounts (provider, providerAccountId);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL, sessionToken TEXT NOT NULL PRIMARY KEY,
  userId TEXT NOT NULL, expires DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT NOT NULL PRIMARY KEY, name TEXT, email TEXT, emailVerified DATETIME, image TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier TEXT NOT NULL, token TEXT NOT NULL PRIMARY KEY, expires DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS password_credentials (
  user_id TEXT NOT NULL PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE assets ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS assets_owner_created_idx ON assets (owner_id, created_at DESC, id DESC);
