-- 统一认证接入（迁移步骤②，auth 项目 PRD P0-6）：OIDC 模式的本地会话表。
-- 30 天本地会话在 OIDC 模式退役；会话 cookie 只存随机 token，这里存其哈希。
-- auth_sid = auth 登录会话指纹（ID token 的 sid），back-channel 登出按它精准吊销。
CREATE TABLE oidc_session (
  token_hash TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,        -- auth 账号 id（过渡期即 tour user id）
  auth_sid   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_oidc_session_sid ON oidc_session (auth_sid);
