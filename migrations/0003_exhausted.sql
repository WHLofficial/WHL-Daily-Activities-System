-- 发放项终态：status 增加 'exhausted'（重试耗尽转人工）。
-- SQLite 无法修改 CHECK 约束，需重建表；数据量小（≤30 人），直接复制。
CREATE TABLE payout_item_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES payout_batch(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  qq_id         TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  breakdown_json TEXT NOT NULL,
  payout_id     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','credited','failed','reversed','exhausted')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error    TEXT,
  credited_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payout_item_new (id, batch_id, user_id, qq_id, amount, breakdown_json, payout_id, status,
                             retry_count, next_retry_at, last_error, credited_at, created_at)
  SELECT id, batch_id, user_id, qq_id, amount, breakdown_json, payout_id, status,
         retry_count, next_retry_at, last_error, credited_at, created_at
    FROM payout_item;
DROP TABLE payout_item;
ALTER TABLE payout_item_new RENAME TO payout_item;
CREATE INDEX idx_payout_due ON payout_item(status, next_retry_at);
CREATE INDEX idx_payout_batch ON payout_item(batch_id);
