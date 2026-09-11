-- 猜胜负（跨场次）玩法：一个玩法项覆盖本次竞猜的全部场次。
--   play_item 因此需要三处变化：
--     ① match_id 可空（跨场次项不属于任何一场）
--     ② 自带 event_id（原来靠 match.event_id 反查，match_id 为空后就查不到了）
--     ③ type 白名单加 'wdl_all'
-- D1 默认开启外键，改列只能重建表；prediction 有外键指向 play_item，
-- 所以顺序固定：建新表 → 建指向新表的 prediction → 复制 → 删旧表 → 改名。
-- （改名时外键已开启，prediction 的 REFERENCES 会自动跟着改成新名。）

CREATE TABLE play_item_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES event(id),
  match_id   INTEGER REFERENCES match(id),
  type       TEXT NOT NULL CHECK (type IN ('score','wdl','goals','fun','wdl_all')),
  question   TEXT NOT NULL,
  tier_json  TEXT NOT NULL,
  reward_cap INTEGER,                   -- NULL → 用 event.reward_cap
  sort       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO play_item_new (id, event_id, match_id, type, question, tier_json, reward_cap, sort)
SELECT i.id, m.event_id, i.match_id, i.type, i.question, i.tier_json, i.reward_cap, i.sort
  FROM play_item i JOIN match m ON m.id = i.match_id;

CREATE TABLE prediction_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  play_item_id INTEGER NOT NULL REFERENCES play_item_new(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  content_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (play_item_id, user_id)
);

INSERT INTO prediction_new (id, play_item_id, user_id, content_json, created_at, updated_at)
SELECT id, play_item_id, user_id, content_json, created_at, updated_at FROM prediction;

DROP TABLE prediction;
DROP TABLE play_item;
ALTER TABLE play_item_new RENAME TO play_item;
ALTER TABLE prediction_new RENAME TO prediction;

CREATE INDEX idx_item_match ON play_item(match_id);
CREATE INDEX idx_item_event ON play_item(event_id);
CREATE INDEX idx_pred_item ON prediction(play_item_id);
CREATE INDEX idx_pred_user ON prediction(user_id);
