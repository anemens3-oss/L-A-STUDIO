-- Миграция 0003: Совместимость со схемой удалённой базы Cloudflare D1 (lea-booking-db)
-- и таблица истории изменений записей (booking_audit_logs).
-- Данная миграция НЕ удаляет таблицы и НЕ стирает существующие записи.

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_booking ON notification_logs(booking_id);

CREATE TABLE IF NOT EXISTS booking_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_audit_logs_booking ON booking_audit_logs(booking_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

-- Перевод старых записей очереди (если были со значением 'max_bot') на канал 'telegram'
UPDATE notification_queue SET channel = 'telegram' WHERE channel = 'max_bot';

