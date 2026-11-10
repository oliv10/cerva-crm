CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('residential', 'commercial')),
  property_type TEXT,
  address TEXT,
  city TEXT,
  sq_ft INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))
);

CREATE TABLE deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'quoted', 'won', 'lost')),
  cleaning_type TEXT,
  frequency TEXT,
  value_cents INTEGER,
  preferred_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE email_touch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_email TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  last_contact_at TEXT NOT NULL,
  gmail_thread_id TEXT,
  subject TEXT
);

CREATE UNIQUE INDEX idx_email_touch_email ON email_touch(contact_email);
CREATE INDEX idx_email_touch_last_contact ON email_touch(last_contact_at);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_account ON contacts(account_id);
CREATE INDEX idx_deals_account ON deals(account_id);
CREATE INDEX idx_deals_stage ON deals(stage);

-- App settings (gmail refresh token, oauth state)
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
