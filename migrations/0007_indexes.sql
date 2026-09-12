-- 热路径补索引：
-- 1) match(event_id)：用户/管理详情、录结果、提交校验、战报都按 event_id 拉场次，此前全表扫
-- 2) report(status, created_at)：插件轮询 WHERE status='pending' ORDER BY created_at，以及各扫描按状态过滤
CREATE INDEX IF NOT EXISTS idx_match_event ON "match"(event_id);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status, created_at);
