-- ============================================================================
-- LÉA STUDIO — Схема базы данных Cloudflare D1 / SQLite
-- Включает атомарную защиту от двойной записи (таблица слотов + триггеры БД)
-- и совместимость с таблицами/полями Telegram-уведомлений (lea-booking-db)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Настройки салона (легко заменяемые конфигурационные параметры)
CREATE TABLE IF NOT EXISTS salon_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

-- 2. Категории услуг
CREATE TABLE IF NOT EXISTS service_categories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- 3. Услуги салона
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 15 AND duration_minutes <= 360 AND duration_minutes % 5 = 0),
  price_rub INTEGER NOT NULL CHECK (price_rub > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 4. Мастера салона
CREATE TABLE IF NOT EXISTS masters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  specialization TEXT NOT NULL,
  bio TEXT NOT NULL,
  experience_years INTEGER NOT NULL DEFAULT 3,
  portrait_key TEXT NOT NULL DEFAULT 'anna',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 5. Связь мастеров с услугами (строго определяет, какие услуги выполняет мастер)
CREATE TABLE IF NOT EXISTS master_services (
  master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);

-- 6. Еженедельный график работы мастеров и перерывы
-- day_of_week: 0 = Воскресенье, 1 = Понедельник, ..., 6 = Суббота
CREATE TABLE IF NOT EXISTS master_schedules (
  master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  is_working INTEGER NOT NULL DEFAULT 1,
  start_minute INTEGER NOT NULL DEFAULT 600,       -- 10:00 (600 мин)
  end_minute INTEGER NOT NULL DEFAULT 1260,        -- 21:00 (1260 мин)
  break_start_minute INTEGER,                      -- Например, 840 (14:00)
  break_end_minute INTEGER,                        -- Например, 885 (14:45)
  PRIMARY KEY (master_id, day_of_week)
);

-- 7. Исключения графика (выходные дни, отпуска, нестандартные смены или перерывы на дату)
CREATE TABLE IF NOT EXISTS master_exceptions (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL,                    -- YYYY-MM-DD
  is_day_off INTEGER NOT NULL DEFAULT 1,
  custom_start_minute INTEGER,
  custom_end_minute INTEGER,
  break_start_minute INTEGER,
  break_end_minute INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE (master_id, exception_date)
);

-- 8. Временное удержание слотов (Slot Holds) при заполнении данных клиентом
-- Срок удержания явно ограничен полем expires_at (по умолчанию 5 минут = 300 секунд)
CREATE TABLE IF NOT EXISTS slot_holds (
  master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  slot_date TEXT NOT NULL,                         -- YYYY-MM-DD
  slot_minute INTEGER NOT NULL,                    -- Шаг 5 минут от 00:00
  hold_token TEXT NOT NULL,                        -- Идентификатор сессии клиента
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  expires_at INTEGER NOT NULL,                     -- Unix timestamp (секунды)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (master_id, slot_date, slot_minute)
);

CREATE INDEX IF NOT EXISTS idx_slot_holds_expires ON slot_holds(expires_at);
CREATE INDEX IF NOT EXISTS idx_slot_holds_token ON slot_holds(hold_token);

-- 9. Таблица бронирований (Bookings)
-- Включает поля telegram_status, telegram_attempts и telegram_last_error для полной совместимости с lea-booking-db
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
  booking_date TEXT NOT NULL,                      -- YYYY-MM-DD (в часовом поясе салона)
  start_time TEXT NOT NULL,                        -- HH:MM
  end_time TEXT NOT NULL,                          -- HH:MM
  start_minute INTEGER NOT NULL,                   -- Минуты от начала суток
  end_minute INTEGER NOT NULL,                     -- start_minute + duration_minutes
  duration_minutes INTEGER NOT NULL,
  price_rub INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  client_first_name TEXT NOT NULL DEFAULT '',
  client_last_name TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL,
  client_comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    notification_status IN ('pending', 'sent', 'failed_retry_scheduled', 'failed_permanent', 'awaiting_configuration')
  ),
  telegram_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    telegram_status IN ('pending', 'sent', 'failed_retry_scheduled', 'failed_permanent', 'awaiting_configuration')
  ),
  telegram_attempts INTEGER NOT NULL DEFAULT 0,
  telegram_last_error TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  cancelled_at TEXT,
  CHECK (end_minute > start_minute)
);

CREATE INDEX IF NOT EXISTS idx_bookings_master_date ON bookings(master_id, booking_date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at);

-- 10. Таблица занятых атомарных слотов (Booked Slots)
-- Каждый 5-минутный интервал [start_minute, end_minute) имеет уникальный первичный ключ (master_id, slot_date, slot_minute).
-- Это гарантирует на уровне движка БД невозможность захвата одного интервала двумя параллельными транзакциями.
CREATE TABLE IF NOT EXISTS booked_slots (
  master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
  slot_date TEXT NOT NULL,                         -- YYYY-MM-DD
  slot_minute INTEGER NOT NULL,                    -- Дискретный 5-минутный блок
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, slot_date, slot_minute)
);

CREATE INDEX IF NOT EXISTS idx_booked_slots_booking_id ON booked_slots(booking_id);

-- 11. Очередь уведомлений администратору в Telegram (notification_queue)
CREATE TABLE IF NOT EXISTS notification_queue (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sent', 'failed_retry_scheduled', 'failed_permanent', 'awaiting_configuration')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at INTEGER,                           -- Unix timestamp (секунды)
  last_http_status INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_retry ON notification_queue(status, next_retry_at);

-- 12. Журнал событий отправки уведомлений в Telegram (notification_logs — совместимость с lea-booking-db)
-- Никогда не сохраняет секретные токены в полях error_code / error_message
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

-- 13. История изменений записи (booking_audit_logs)
CREATE TABLE IF NOT EXISTS booking_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                            -- created, confirmed, cancelled, rescheduled, status_changed
  actor TEXT NOT NULL DEFAULT 'system',            -- client, admin, system
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_audit_logs_booking ON booking_audit_logs(booking_id);

-- ============================================================================
-- ТРИГГЕРЫ ЦЕЛОСТНОСТИ И ЗАЩИТЫ ОТ ДВОЙНОГО БРОНИРОВАНИЯ НА УРОВНЕ СУБД
-- ============================================================================

-- Триггер 1: Строгая проверка, что выбранный мастер действительно оказывает данную услугу
CREATE TRIGGER IF NOT EXISTS trg_validate_master_service
BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MASTER_SERVICE_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM master_services ms
    JOIN masters m ON m.id = ms.master_id
    JOIN services s ON s.id = ms.service_id
    WHERE ms.master_id = NEW.master_id
      AND ms.service_id = NEW.service_id
      AND m.is_active = 1
      AND s.is_active = 1
  );
END;

-- Триггер 2: Строгий запрет пересечения интервалов на одного мастера на уровне таблицы bookings
CREATE TRIGGER IF NOT EXISTS trg_prevent_booking_overlap
BEFORE INSERT ON bookings
FOR EACH ROW
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_OVERLAP_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = NEW.master_id
      AND b.booking_date = NEW.booking_date
      AND b.status = 'confirmed'
      AND NEW.start_minute < b.end_minute
      AND NEW.end_minute > b.start_minute
  );
END;

-- Триггер 3: Автоматическое освобождение слотов при отмене записи
CREATE TRIGGER IF NOT EXISTS trg_release_slots_on_cancel
AFTER UPDATE OF status ON bookings
FOR EACH ROW
WHEN NEW.status = 'cancelled' AND OLD.status != 'cancelled'
BEGIN
  DELETE FROM booked_slots WHERE booking_id = OLD.id;
END;
