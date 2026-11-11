-- Site address lives on deals (cleaning sites), not accounts (clients).
ALTER TABLE deals ADD COLUMN address TEXT;
ALTER TABLE deals ADD COLUMN city TEXT;
ALTER TABLE deals ADD COLUMN property_type TEXT;
ALTER TABLE deals ADD COLUMN sq_ft INTEGER;

UPDATE deals
SET
  address = (SELECT address FROM accounts WHERE accounts.id = deals.account_id),
  city = (SELECT city FROM accounts WHERE accounts.id = deals.account_id),
  property_type = (SELECT property_type FROM accounts WHERE accounts.id = deals.account_id),
  sq_ft = (SELECT sq_ft FROM accounts WHERE accounts.id = deals.account_id);

ALTER TABLE accounts DROP COLUMN address;
ALTER TABLE accounts DROP COLUMN city;
ALTER TABLE accounts DROP COLUMN property_type;
ALTER TABLE accounts DROP COLUMN sq_ft;
