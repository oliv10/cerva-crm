-- Phase 1: deals → opportunities (+ stages/follow-ups), activities, customers.
-- Keep accounts as org parent for contacts + Gmail last-contact.

CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'new_lead' CHECK (stage IN (
    'new_lead',
    'contact_attempted',
    'connected',
    'interested',
    'walkthrough_scheduled',
    'walkthrough_completed',
    'proposal_sent',
    'follow_up',
    'verbal_approval',
    'won',
    'lost',
    'nurture'
  )),
  lead_source TEXT,
  cleaning_type TEXT,
  frequency TEXT,
  estimated_mrr_cents INTEGER,
  quoted_mrr_cents INTEGER,
  expected_start TEXT,
  next_follow_up_at TEXT,
  next_action TEXT,
  lost_reason TEXT,
  address TEXT,
  city TEXT,
  property_type TEXT,
  sq_ft INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO opportunities (
  id, account_id, stage, cleaning_type, frequency, quoted_mrr_cents,
  expected_start, address, city, property_type, sq_ft, notes, created_at
)
SELECT
  id,
  account_id,
  CASE stage
    WHEN 'lead' THEN 'new_lead'
    WHEN 'quoted' THEN 'proposal_sent'
    WHEN 'won' THEN 'won'
    WHEN 'lost' THEN 'lost'
    ELSE 'new_lead'
  END,
  cleaning_type,
  frequency,
  value_cents,
  preferred_at,
  address,
  city,
  property_type,
  sq_ft,
  notes,
  created_at
FROM deals;

DROP TABLE deals;

CREATE INDEX idx_opportunities_account ON opportunities(account_id);
CREATE INDEX idx_opportunities_stage ON opportunities(stage);
CREATE INDEX idx_opportunities_follow_up ON opportunities(next_follow_up_at);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  happened_at TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL DEFAULT 'note',
  person TEXT,
  summary TEXT NOT NULL,
  outcome TEXT,
  next_action TEXT,
  next_follow_up_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_activities_opportunity ON activities(opportunity_id);
CREATE INDEX idx_activities_happened ON activities(happened_at);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('residential', 'commercial')),
  service_address TEXT,
  city TEXT,
  frequency TEXT,
  mrr_cents INTEGER,
  start_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customers_account ON customers(account_id);
CREATE UNIQUE INDEX idx_customers_opportunity ON customers(opportunity_id);

-- Convert already-won opportunities into customers.
INSERT INTO customers (
  account_id, opportunity_id, name, type, service_address, city, frequency, mrr_cents, start_date, notes
)
SELECT
  o.account_id,
  o.id,
  a.name,
  a.type,
  o.address,
  o.city,
  o.frequency,
  o.quoted_mrr_cents,
  o.expected_start,
  o.notes
FROM opportunities o
JOIN accounts a ON a.id = o.account_id
WHERE o.stage = 'won'
  AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.opportunity_id = o.id);
