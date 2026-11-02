CREATE TABLE homes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT fk_members_home FOREIGN KEY (home_id) REFERENCES homes (id),
  CONSTRAINT uq_members_home_name UNIQUE (home_id, name)
);

CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  home_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  CONSTRAINT fk_bills_home FOREIGN KEY (home_id) REFERENCES homes (id),
  CONSTRAINT chk_bills_positive CHECK (total_cents > 0)
);

CREATE TABLE shares (
  id           TEXT PRIMARY KEY,
  bill_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at      TEXT    DEFAULT NULL,
  idempotency_key TEXT DEFAULT NULL,
  CONSTRAINT fk_shares_bill   FOREIGN KEY (bill_id)   REFERENCES bills (id),
  CONSTRAINT fk_shares_member FOREIGN KEY (member_id) REFERENCES members (id),
  CONSTRAINT chk_shares_positive CHECK (amount_cents > 0),
  CONSTRAINT uq_shares_idempotency_key UNIQUE (id, idempotency_key)
);

