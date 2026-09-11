-- 开放通知与截止提醒：复用 report 表下发（kind 区分战报 report / 开放通知 open / 截止提醒 remind），
-- event.reminded_at 记录提醒已入队，避免每 5 分钟的扫描重复提醒。
ALTER TABLE report ADD COLUMN kind TEXT NOT NULL DEFAULT 'report';
ALTER TABLE event ADD COLUMN reminded_at TEXT;
