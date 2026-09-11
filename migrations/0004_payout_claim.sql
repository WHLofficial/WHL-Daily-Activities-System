-- 派发认领锁：确认发奖、手动重试、cron 三条路径可能同时扫到同一批待发项。
-- 派发前先原子抢 claim_at，抢不到就跳过，避免同一笔被并发提交（写列即可，无需像 0003 那样重建表）。
ALTER TABLE payout_item ADD COLUMN claim_at TEXT;
