-- 对接赛事系统账号（B1）：竞猜侧只存镜像 + 附加角色
-- users.tour_id = 赛事系统 user.id（唯一索引，首次共享会话访问时 upsert）
-- 注意：SQLite 的 ALTER TABLE 不支持内联 UNIQUE，必须用唯一索引
ALTER TABLE users ADD COLUMN tour_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tour_id ON users(tour_id);

-- 发起人名单：谁可以开期/截止/录比分/结算/确认（管理员在后台勾选）
-- 角色体系仍以赛事系统为准（admin/superadmin 映射为竞猜 admin），initiator 不进 users.role
CREATE TABLE initiators (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
