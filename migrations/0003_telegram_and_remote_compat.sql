-- Миграция 0003: Совместимость со схемой удалённой базы Cloudflare D1 (lea-booking-db)
--
-- Назначение этой миграции:
-- Ранее в удалённой базе lea-booking-db использовались таблицы:
--   bookings (с полями telegram_status, telegram_attempts, telegram_last_error),
--   services, staff, working_hours, notification_logs.
-- Текущая версия Worker и фронтенда использует расширенную атомарную схему:
--   salon_settings, service_categories, services, masters, master_services,
--   master_schedules, master_exceptions, slot_holds, bookings, booked_slots,
--   notification_queue, notification_logs.
--
-- Данная миграция НЕ удаляет таблицы и НЕ стирает существующие записи.
-- Она создаёт недостающие совместимые представления/таблицы (staff, working_hours, notification_logs),
-- чтобы ни старые данные, ни новый функционал не конфликтовали друг с другом.

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

-- Перевод старых записей очереди (если были со значением 'max_bot') на канал 'telegram'
UPDATE notification_queue SET channel = 'telegram' WHERE channel = 'max_bot';
