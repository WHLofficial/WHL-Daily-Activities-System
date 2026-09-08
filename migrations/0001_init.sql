-- WHL 竞猜系统 D1 初始 schema（对应 TECH_DESIGN.md 第三节）
-- 余额真源在 AstrBot 插件侧；本库只存业务数据 + 应发凭证 + 流水镜像。

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('default_tiers',      '{"score":300,"goals":100,"wdl":50,"fun":50}'),
  ('reward_cap_default', '1000');

-- 账号（B1：external_id 预留赛事系统账号对接；当前自建会话为退路实现）
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','initiator','user')),
  external_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- B2：一次性绑定码（10 分钟、一码一次）
CREATE TABLE bind_codes (
  code       TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- QQ 映射：user/qq 双向唯一，天然防多号
CREATE TABLE user_binding (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL UNIQUE REFERENCES users(id),
  qq_id    TEXT NOT NULL UNIQUE,
  status   TEXT NOT NULL DEFAULT 'active',
  bound_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A1/A2：竞猜期
CREATE TABLE event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'draft'
             CHECK (status IN ('draft','open','sealed','settled','paid','archived')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  deadline   TEXT NOT NULL,             -- ISO UTC；提交截止
  reward_cap INTEGER NOT NULL DEFAULT 1000,  -- 玩法项默认奖励上限
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_status ON event(status);

CREATE TABLE match (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES event(id),
  home       TEXT NOT NULL,
  away       TEXT NOT NULL,
  kickoff    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 玩法项：tier_json 为该题生效档位（创建时从全局默认复制/覆盖）
--   score 项: {"score":300,"goals":100,"wdl":50}（一份比分预测可命中多档，取最高档）
--   wdl/goals/fun 项: 单档 {"wdl":50} / {"goals":100} / {"fun":80}
CREATE TABLE play_item (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES match(id),
  type       TEXT NOT NULL CHECK (type IN ('score','wdl','goals','fun')),
  question   TEXT NOT NULL,
  tier_json  TEXT NOT NULL,
  reward_cap INTEGER,                   -- NULL → 用 event.reward_cap
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_item_match ON play_item(match_id);

-- A3：预测，唯一(玩法项,用户)防一人多份
CREATE TABLE prediction (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  play_item_id INTEGER NOT NULL REFERENCES play_item(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  content_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (play_item_id, user_id)
);
CREATE INDEX idx_pred_item ON prediction(play_item_id);
CREATE INDEX idx_pred_user ON prediction(user_id);

-- A5/A6：结算（录比分后计算，发奖前可重算覆盖）
CREATE TABLE settlement (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL UNIQUE REFERENCES event(id),
  result_json  TEXT NOT NULL,           -- 各场实际比分 + 趣味题命中名单
  detail_json  TEXT NOT NULL,           -- 每人每题判定明细
  total_amount INTEGER NOT NULL,
  cap_breached INTEGER NOT NULL DEFAULT 0,
  confirmed_by INTEGER,
  computed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payout_batch (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL UNIQUE REFERENCES event(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','partial')),
  total_amount INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A7：发放项，payout_id 全局唯一 = 幂等键 = 防重发最终防线
CREATE TABLE payout_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES payout_batch(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  qq_id         TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  breakdown_json TEXT NOT NULL,
  payout_id     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','credited','failed','reversed')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error    TEXT,
  credited_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payout_due ON payout_item(status, next_retry_at);
CREATE INDEX idx_payout_batch ON payout_item(batch_id);

-- F2：每次尝试留痕（含超时 unknown）
CREATE TABLE sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id  TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  outcome    TEXT NOT NULL,             -- credited | duplicate | unknown | failed
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_synclog_payout ON sync_log(payout_id);

-- 流水镜像：竞猜侧账本，对账本地依据（正=奖励，负=冲正）
CREATE TABLE ledger_mirror (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id   TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL,
  qq_id       TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('reward','reversal')),
  event_id    INTEGER NOT NULL,
  mirrored_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_event ON ledger_mirror(event_id);

-- A8：战报（插件出站拉取）
CREATE TABLE report (
  id         TEXT PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id),
  content    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);

-- A9：对账记录
CREATE TABLE recon_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_date TEXT NOT NULL,            -- Asia/Shanghai 日期
  expect_json TEXT NOT NULL,            -- 应收（镜像汇总）
  actual_json TEXT,                     -- 实发（插件 summary）
  diff_json   TEXT,
  status      TEXT NOT NULL CHECK (status IN ('ok','diff','skipped','error')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
