-- 0003 · 接口限流
--
-- 固定窗口计数器：一次 upsert 完成累加+读取，靠主键 (key, window_start) 保证并发安全。
-- 过期窗口由应用侧低概率清理，不依赖定时任务。

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
