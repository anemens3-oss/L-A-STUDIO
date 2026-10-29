/**
 * LÉA STUDIO — Серверная часть (Cloudflare Workers + Cloudflare D1)
 * Реализована исключительно на стандартных Web API (Fetch, URL, Request, Response, Web Crypto, AbortController)
 * без сторонних runtime-библиотек.
 *
 * Ключевые механизмы безопасности и надёжности:
 * 1. Автоматическая безопасная адаптация к существующей схеме БД (включая старую схему lea-booking-db
 *    с таблицами services, staff, working_hours, bookings [first_name, last_name, staff_id, start_minutes, end_minutes]
 *    без удаления таблиц и существующих записей).
 * 2. Атомарное резервирование интервалов через env.DB.batch() (транзакция SQLite/D1)
 *    + таблица 5-минутных слотов booked_slots с PRIMARY KEY (master_id, slot_date, slot_minute)
 *    + триггер БД trg_prevent_booking_overlap для защиты от любых пересечений по длительности.
 * 3. Защищённая панель администратора (/api/admin/*):
 *    - серверная аутентификация по логину и паролю (SHA-256 + константное время сравнения);
 *    - защищённая сессия в Cookie (HttpOnly, Secure, SameSite=Strict) + защита от CSRF (X-CSRF-Token) + Bearer;
 *    - ограничение частоты попыток входа (Rate Limiting);
 *    - управление записями (просмотр, подтверждение, отмена с освобождением слотов, перенос с проверкой конфликтов, история изменений);
 *    - управление услугами, мастерами и расписанием (безопасное отключение вместо удаления).
 * 4. Отправка уведомлений администратору через официальный Telegram Bot API
 *    при создании, отмене и переносе записи.
 */

const SLOT_UNIT_MINUTES = 5;
const DEFAULT_TIMEZONE_OFFSET_MINUTES = 180; // Europe/Moscow (UTC+3)
const DEFAULT_MIN_LEAD_MINUTES = 30;
const DEFAULT_HOLD_TTL_SECONDS = 300; // 5 минут на заполнение контактов
const DEFAULT_HORIZON_DAYS = 45;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 8000;
const DEFAULT_MAX_NOTIFICATION_ATTEMPTS = 5;
const ADMIN_SESSION_TTL_SECONDS = 12 * 3600; // 12 часов

// По умолчанию логин "admin" и SHA-256 хеш стартового пароля администратора.
// В production обязательно переопределяется через серверные секреты ADMIN_USERNAME и ADMIN_PASSWORD_SHA256.
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD_SHA256 =
  '8472df4d8e26ebc36edd315e099b770e025261ec6575b2b90c31a9800d7001c7';

const SLOT_CONFLICT_MESSAGE_RU =
  'Это время уже занято. Пожалуйста, выберите другое';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Idempotency-Key, X-CSRF-Token',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// Ограничитель частоты публичных POST-запросов по IP
const rateLimitBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 45;

// Строгий ограничитель попыток входа в панель администратора
const loginRateLimitBuckets = new Map();
const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 минут
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;

// Отозванные сессии при выходе из аккаунта (logout)
const revokedSessionTokens = new Set();

// Кеш инициализации схемы для конкретного объекта БД
const initializedDatabases = new WeakSet();
const dbLegacyColumnsCache = new WeakMap();

export function resetRateLimitersForTests() {
  rateLimitBuckets.clear();
  loginRateLimitBuckets.clear();
  revokedSessionTokens.clear();
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    ''
  );
}

function checkRateLimit(request) {
  const clientIp = getClientIp(request);
  if (!clientIp) {
    return { allowed: true };
  }
  const now = Date.now();
  let bucket = rateLimitBuckets.get(clientIp);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
  }
  bucket.count += 1;
  rateLimitBuckets.set(clientIp, bucket);

  if (rateLimitBuckets.size > 2000) {
    for (const [k, v] of rateLimitBuckets.entries()) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitBuckets.delete(k);
      }
    }
  }

  return { allowed: bucket.count <= RATE_LIMIT_MAX_REQUESTS };
}

function checkLoginRateLimit(request) {
  const key = getClientIp(request) || 'local-client';
  const now = Date.now();
  let bucket = loginRateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, failedCount: 0 };
    loginRateLimitBuckets.set(key, bucket);
  }
  if (bucket.failedCount >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
    return { allowed: false, remaining: 0 };
  }
  return {
    allowed: true,
    remaining: LOGIN_RATE_LIMIT_MAX_ATTEMPTS - bucket.failedCount,
  };
}

function recordFailedLoginAttempt(request) {
  const key = getClientIp(request) || 'local-client';
  const now = Date.now();
  let bucket = loginRateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, failedCount: 0 };
  }
  bucket.failedCount += 1;
  loginRateLimitBuckets.set(key, bucket);
}

function clearLoginAttempts(request) {
  const key = getClientIp(request) || 'local-client';
  loginRateLimitBuckets.delete(key);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(code, message, status = 400, details = undefined, extraHeaders = {}) {
  const payload = { ok: false, error: { code, message } };
  if (details !== undefined) {
    payload.error.details = details;
  }
  return jsonResponse(payload, status, extraHeaders);
}

function getSalonNow(offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES, env = {}) {
  const nowMs = env && env.__TEST_NOW_ISO ? Date.parse(env.__TEST_NOW_ISO) : Date.now();
  const shiftedMs = nowMs + offsetMinutes * 60 * 1000;
  const shiftedDate = new Date(shiftedMs);

  const year = shiftedDate.getUTCFullYear();
  const month = String(shiftedDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shiftedDate.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const hours = shiftedDate.getUTCHours();
  const minutes = shiftedDate.getUTCMinutes();
  const minuteOfDay = hours * 60 + minutes;

  return {
    nowUnixSeconds: Math.floor(nowMs / 1000),
    nowIsoUtc: new Date(nowMs).toISOString(),
    dateStr,
    minuteOfDay,
    timeStr: minutesToHHMM(minuteOfDay),
  };
}

function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseHHMMToMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr.trim())) {
    return null;
  }
  const [hStr, mStr] = timeStr.trim().split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function parseDateYMD(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return {
    year: y,
    month: m,
    day: d,
    dayOfWeek: dt.getUTCDay(), // 0 = Sun .. 6 = Sat
    utcMs: dt.getTime(),
  };
}

function diffDaysYMD(dateA, dateB) {
  const parsedA = parseDateYMD(dateA);
  const parsedB = parseDateYMD(dateB);
  if (!parsedA || !parsedB) return null;
  return Math.round((parsedA.utcMs - parsedB.utcMs) / (86400 * 1000));
}

function normalizePhone(rawPhone) {
  if (typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    const body = digits.slice(1);
    if (/^0+$/.test(body)) return null;
    return `+7 (${body.slice(0, 3)}) ${body.slice(3, 6)}-${body.slice(6, 8)}-${body.slice(8, 10)}`;
  }
  if (digits.length === 10) {
    if (/^0+$/.test(digits)) return null;
    return `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 10)}`;
  }
  if (digits.length >= 10 && digits.length <= 15) {
    if (/^0+$/.test(digits)) return null;
    return `+${digits}`;
  }
  return null;
}

function splitFullName(fullName, explicitFirst = '', explicitLast = '') {
  const f = String(explicitFirst || '').trim();
  const l = String(explicitLast || '').trim();
  if (f && l) {
    return { firstName: f, lastName: l, fullName: `${f} ${l}`.trim() };
  }
  const combined = String(fullName || f || '').trim();
  if (!combined) {
    return { firstName: '', lastName: l, fullName: l };
  }
  const parts = combined.split(/\s+/);
  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: l,
      fullName: l ? `${parts[0]} ${l}` : parts[0],
    };
  }
  const firstName = parts[0];
  const lastName = l || parts.slice(1).join(' ');
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
  };
}

function generateBookingCode(dateStr) {
  const compactDate = dateStr.replace(/-/g, '').slice(2); // YYMMDD
  const randomBytes = new Uint8Array(3);
  crypto.getRandomValues(randomBytes);
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let suffix = '';
  for (let i = 0; i < randomBytes.length; i++) {
    suffix += alphabet[randomBytes[i] % alphabet.length];
  }
  const extra = alphabet[Math.floor(Math.random() * alphabet.length)];
  return `LEA-${compactDate}-${suffix}${extra}`;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getSigningSecret(env) {
  const baseHash = (
    env?.ADMIN_PASSWORD_SHA256 || DEFAULT_ADMIN_PASSWORD_SHA256
  ).toLowerCase();
  const extra = env?.ADMIN_SESSION_SECRET || 'lea-studio-admin-session-v1';
  return `${baseHash}:${extra}`;
}

async function createAdminSessionToken(env, login) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ADMIN_SESSION_TTL_SECONDS;
  const randomBytes = new Uint8Array(12);
  crypto.getRandomValues(randomBytes);
  const nonce = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const csrfBytes = new Uint8Array(16);
  crypto.getRandomValues(csrfBytes);
  const csrfToken = Array.from(csrfBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const payloadObj = {
    sub: login || DEFAULT_ADMIN_USERNAME,
    iat: nowSec,
    exp: expSec,
    jti: nonce,
    csrf: csrfToken,
  };
  const payloadB64 = btoa(JSON.stringify(payloadObj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = await hmacSha256Hex(getSigningSecret(env), payloadB64);
  return {
    token: `sess.${payloadB64}.${signature}`,
    csrfToken,
    expiresAt: expSec,
    login: payloadObj.sub,
  };
}

async function verifyAdminSessionToken(token, env) {
  if (!token || typeof token !== 'string' || !token.startsWith('sess.')) {
    return null;
  }
  if (revokedSessionTokens.has(token)) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [, payloadB64, sigHex] = parts;
  const expectedSig = await hmacSha256Hex(getSigningSecret(env), payloadB64);
  if (!timingSafeEqualHex(sigHex.toLowerCase(), expectedSig.toLowerCase())) {
    return null;
  }
  try {
    const normalizedB64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalizedB64.length % 4)) % 4;
    const jsonStr = atob(normalizedB64 + '='.repeat(padLen));
    const payload = JSON.parse(jsonStr);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return map;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) map[k] = decodeURIComponent(v);
  }
  return map;
}

/**
 * Проверяет авторизацию администратора по:
 * 1. Защищённой сессионной Cookie `lea_admin_session` (HttpOnly; Secure; SameSite=Strict)
 *    с проверкой X-CSRF-Token для модифицирующих запросов (POST/PUT/PATCH/DELETE).
 * 2. Заголовку `Authorization: Bearer <sessionToken или password>`.
 */
async function authenticateAdminRequest(request, env, { requireCsrf = false } = {}) {
  const expectedHash = (
    env?.ADMIN_PASSWORD_SHA256 || DEFAULT_ADMIN_PASSWORD_SHA256
  ).toLowerCase();

  // 1. Проверка Bearer-заголовка
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearerValue = authHeader.slice('Bearer '.length).trim();
    if (bearerValue) {
      if (bearerValue.startsWith('sess.')) {
        const sessionPayload = await verifyAdminSessionToken(bearerValue, env);
        if (sessionPayload) {
          return {
            authorized: true,
            login: sessionPayload.sub,
            csrfToken: sessionPayload.csrf,
            token: bearerValue,
            via: 'bearer_session',
          };
        }
        return { authorized: false, reason: 'INVALID_SESSION_TOKEN' };
      }

      // Прямая передача пароля в Bearer (поддержка существующих интеграционных тестов и CLI)
      const actualHash = await sha256Hex(bearerValue);
      if (timingSafeEqualHex(actualHash, expectedHash)) {
        const derivedCsrf = (await hmacSha256Hex(getSigningSecret(env), 'bearer-csrf')).slice(
          0,
          32
        );
        return {
          authorized: true,
          login: env?.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
          csrfToken: derivedCsrf,
          token: null,
          via: 'bearer_password',
        };
      }
      return { authorized: false, reason: 'INVALID_CREDENTIALS' };
    }
  }

  // 2. Проверка HttpOnly Cookie `lea_admin_session`
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const cookieToken = cookies.lea_admin_session;
  if (cookieToken) {
    const sessionPayload = await verifyAdminSessionToken(cookieToken, env);
    if (!sessionPayload) {
      return { authorized: false, reason: 'EXPIRED_OR_INVALID_COOKIE' };
    }

    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method.toUpperCase()
    );
    if ((requireCsrf || isMutating) && sessionPayload.csrf) {
      const csrfHeader = (request.headers.get('X-CSRF-Token') || '').trim();
      if (!csrfHeader || !timingSafeEqualHex(csrfHeader, sessionPayload.csrf)) {
        return { authorized: false, reason: 'CSRF_TOKEN_MISMATCH' };
      }
    }

    return {
      authorized: true,
      login: sessionPayload.sub,
      csrfToken: sessionPayload.csrf,
      token: cookieToken,
      via: 'cookie',
    };
  }

  return { authorized: false, reason: 'MISSING_AUTH' };
}

async function isAdminAuthorized(request, env) {
  const res = await authenticateAdminRequest(request, env);
  return res.authorized;
}

// ============================================================================
// АВТОМАТИЧЕСКАЯ СОВМЕСТИМОСТЬ И МИГРАЦИЯ СХЕМЫ БД (БЕЗ ПОТЕРИ ДАННЫХ)
// ============================================================================

async function getTableColumns(db, tableName) {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((results || []).map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

/**
 * Безопасно проверяет и подготавливает таблицы в подключённой базе D1 / SQLite.
 * Сохраняет все существующие таблицы и записи в `lea-booking-db` (включая старую схему
 * с таблицами `services`, `staff`, `working_hours`, `bookings` [first_name, last_name, staff_id, start_minutes, end_minutes]).
 */
async function ensureDatabaseReady(db) {
  if (!db || initializedDatabases.has(db)) {
    return dbLegacyColumnsCache.get(db) || { hasLegacyBookingColumns: false };
  }

  try {
    // 1. Создаём недостающие таблицы без удаления существующих
    const createTablesSql = [
      `CREATE TABLE IF NOT EXISTS salon_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS service_categories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL DEFAULT 'manicure',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        duration_minutes INTEGER NOT NULL DEFAULT 60,
        price_rub INTEGER NOT NULL DEFAULT 1000,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_demo INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS masters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Мастер студии',
        specialization TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        experience_years INTEGER NOT NULL DEFAULT 5,
        portrait_key TEXT NOT NULL DEFAULT 'anna',
        is_active INTEGER NOT NULL DEFAULT 1,
        is_demo INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS master_services (
        master_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        PRIMARY KEY (master_id, service_id)
      )`,
      `CREATE TABLE IF NOT EXISTS master_schedules (
        master_id TEXT NOT NULL,
        day_of_week INTEGER NOT NULL,
        is_working INTEGER NOT NULL DEFAULT 1,
        start_minute INTEGER NOT NULL DEFAULT 600,
        end_minute INTEGER NOT NULL DEFAULT 1260,
        break_start_minute INTEGER,
        break_end_minute INTEGER,
        PRIMARY KEY (master_id, day_of_week)
      )`,
      `CREATE TABLE IF NOT EXISTS master_exceptions (
        id TEXT PRIMARY KEY,
        master_id TEXT NOT NULL,
        exception_date TEXT NOT NULL,
        is_day_off INTEGER NOT NULL DEFAULT 1,
        custom_start_minute INTEGER,
        custom_end_minute INTEGER,
        break_start_minute INTEGER,
        break_end_minute INTEGER,
        reason TEXT NOT NULL DEFAULT '',
        UNIQUE (master_id, exception_date)
      )`,
      `CREATE TABLE IF NOT EXISTS slot_holds (
        master_id TEXT NOT NULL,
        slot_date TEXT NOT NULL,
        slot_minute INTEGER NOT NULL,
        hold_token TEXT NOT NULL,
        service_id TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (master_id, slot_date, slot_minute)
      )`,
      `CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        service_id TEXT NOT NULL,
        master_id TEXT NOT NULL,
        booking_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        start_minute INTEGER NOT NULL,
        end_minute INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,
        price_rub INTEGER NOT NULL,
        client_name TEXT NOT NULL,
        client_first_name TEXT NOT NULL DEFAULT '',
        client_last_name TEXT NOT NULL DEFAULT '',
        client_phone TEXT NOT NULL,
        client_comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'confirmed',
        notification_status TEXT NOT NULL DEFAULT 'pending',
        telegram_status TEXT NOT NULL DEFAULT 'pending',
        telegram_attempts INTEGER NOT NULL DEFAULT 0,
        telegram_last_error TEXT NOT NULL DEFAULT '',
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        cancelled_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS booked_slots (
        master_id TEXT NOT NULL,
        slot_date TEXT NOT NULL,
        slot_minute INTEGER NOT NULL,
        booking_id TEXT NOT NULL,
        PRIMARY KEY (master_id, slot_date, slot_minute)
      )`,
      `CREATE TABLE IF NOT EXISTS notification_queue (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL DEFAULT 'telegram',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_retry_at INTEGER,
        last_http_status INTEGER,
        last_error_code TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'telegram',
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        http_status INTEGER,
        error_code TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )`,
      `CREATE TABLE IF NOT EXISTS booking_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`,
    ];

    for (const sql of createTablesSql) {
      await db.prepare(sql).run();
    }

    // 2. Проверяем колонки существующей таблицы services (на случай старой схемы с category / category_label)
    const serviceCols = await getTableColumns(db, 'services');
    if (!serviceCols.has('category_id')) {
      await db
        .prepare(`ALTER TABLE services ADD COLUMN category_id TEXT NOT NULL DEFAULT 'manicure'`)
        .run();
      if (serviceCols.has('category')) {
        await db.prepare(`UPDATE services SET category_id = category WHERE category IS NOT NULL`).run();
      }
    }
    if (!serviceCols.has('is_demo')) {
      await db.prepare(`ALTER TABLE services ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`).run();
    }

    // Если в старой схеме были категории в таблице services (category, category_label), переносим их в service_categories
    if (serviceCols.has('category') && serviceCols.has('category_label')) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO service_categories (id, title, subtitle, sort_order, is_active)
           SELECT DISTINCT category, category_label, '', 1, 1 FROM services WHERE category IS NOT NULL`
        )
        .run();
    }

    // 3. Проверяем наличие старой таблицы staff и working_hours
    const staffCols = await getTableColumns(db, 'staff');
    if (staffCols.size > 0) {
      // Переносим мастеров из staff в masters без перезаписи уже существующих
      await db
        .prepare(
          `INSERT OR IGNORE INTO masters (id, name, role, specialization, bio, experience_years, portrait_key, is_active, is_demo, sort_order)
           SELECT id, name, role, COALESCE(default_category, role), 'Мастер студии LÉA', 5, 'anna', is_active, 0, 1
           FROM staff`
        )
        .run();

      if (staffCols.has('default_category')) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO master_services (master_id, service_id)
             SELECT st.id, sv.id
             FROM staff st
             JOIN services sv ON sv.category_id = st.default_category`
          )
          .run();
      }
    }

    const workingHoursCols = await getTableColumns(db, 'working_hours');
    if (workingHoursCols.size > 0) {
      const { results: whRows } = await db
        .prepare(`SELECT day_of_week, open_time, close_time, break_start, break_end, is_closed FROM working_hours`)
        .all();
      const { results: allMasters } = await db.prepare(`SELECT id FROM masters`).all();
      if ((whRows || []).length > 0 && (allMasters || []).length > 0) {
        for (const m of allMasters) {
          for (const wh of whRows) {
            const startMin = parseHHMMToMinutes(wh.open_time) ?? 600;
            const endMin = parseHHMMToMinutes(wh.close_time) ?? 1260;
            const breakStartMin = wh.break_start ? parseHHMMToMinutes(wh.break_start) : null;
            const breakEndMin = wh.break_end ? parseHHMMToMinutes(wh.break_end) : null;
            const isWorking = Number(wh.is_closed) === 1 ? 0 : 1;
            await db
              .prepare(
                `INSERT OR IGNORE INTO master_schedules (
                  master_id, day_of_week, is_working, start_minute, end_minute, break_start_minute, break_end_minute
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(
                m.id,
                Number(wh.day_of_week),
                isWorking,
                startMin,
                endMin,
                breakStartMin,
                breakEndMin
              )
              .run();
          }
        }
      }
    }

    // 4. Проверяем колонки таблицы bookings (поддержка старой схемы first_name, last_name, phone, staff_id, start_minutes, end_minutes)
    const bookingCols = await getTableColumns(db, 'bookings');
    const hasLegacyBookingColumns =
      bookingCols.has('first_name') &&
      bookingCols.has('last_name') &&
      bookingCols.has('phone') &&
      bookingCols.has('staff_id');

    const alterBookingColumns = [
      ['master_id', `ALTER TABLE bookings ADD COLUMN master_id TEXT NOT NULL DEFAULT 'any'`],
      ['start_minute', `ALTER TABLE bookings ADD COLUMN start_minute INTEGER NOT NULL DEFAULT 600`],
      ['end_minute', `ALTER TABLE bookings ADD COLUMN end_minute INTEGER NOT NULL DEFAULT 660`],
      ['client_name', `ALTER TABLE bookings ADD COLUMN client_name TEXT NOT NULL DEFAULT ''`],
      ['client_first_name', `ALTER TABLE bookings ADD COLUMN client_first_name TEXT NOT NULL DEFAULT ''`],
      ['client_last_name', `ALTER TABLE bookings ADD COLUMN client_last_name TEXT NOT NULL DEFAULT ''`],
      ['client_phone', `ALTER TABLE bookings ADD COLUMN client_phone TEXT NOT NULL DEFAULT ''`],
      ['client_comment', `ALTER TABLE bookings ADD COLUMN client_comment TEXT NOT NULL DEFAULT ''`],
      ['notification_status', `ALTER TABLE bookings ADD COLUMN notification_status TEXT NOT NULL DEFAULT 'pending'`],
      ['telegram_status', `ALTER TABLE bookings ADD COLUMN telegram_status TEXT NOT NULL DEFAULT 'pending'`],
      ['telegram_attempts', `ALTER TABLE bookings ADD COLUMN telegram_attempts INTEGER NOT NULL DEFAULT 0`],
      ['telegram_last_error', `ALTER TABLE bookings ADD COLUMN telegram_last_error TEXT NOT NULL DEFAULT ''`],
      ['is_demo', `ALTER TABLE bookings ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`],
      ['updated_at', `ALTER TABLE bookings ADD COLUMN updated_at TEXT`],
      ['cancelled_at', `ALTER TABLE bookings ADD COLUMN cancelled_at TEXT`],
    ];

    for (const [colName, sql] of alterBookingColumns) {
      if (!bookingCols.has(colName)) {
        await db.prepare(sql).run();
      }
    }

    // Если в bookings были записи в старом формате, синхронизируем поля и заполняем booked_slots
    if (hasLegacyBookingColumns) {
      await db
        .prepare(
          `UPDATE bookings
           SET master_id = CASE WHEN master_id = '' OR master_id = 'any' THEN staff_id ELSE master_id END,
               start_minute = COALESCE(start_minutes, start_minute),
               end_minute = COALESCE(end_minutes, end_minute),
               client_first_name = CASE WHEN client_first_name = '' THEN first_name ELSE client_first_name END,
               client_last_name = CASE WHEN client_last_name = '' THEN last_name ELSE client_last_name END,
               client_name = CASE
                 WHEN client_name = '' THEN TRIM(first_name || ' ' || last_name)
                 ELSE client_name
               END,
               client_phone = CASE WHEN client_phone = '' THEN phone ELSE client_phone END,
               notification_status = COALESCE(telegram_status, notification_status, 'pending')
           WHERE client_name = '' OR client_phone = ''`
        )
        .run();

      // Синхронизируем подтверждённые записи из старой схемы в booked_slots для атомарной блокировки слотов
      const { results: activeLegacyBookings } = await db
        .prepare(
          `SELECT id, master_id, staff_id, service_id, booking_date, start_minute, end_minute
           FROM bookings
           WHERE status = 'confirmed'`
        )
        .all();

      for (const b of activeLegacyBookings || []) {
        let effectiveMasterId = b.master_id || b.staff_id;
        if (!effectiveMasterId || effectiveMasterId === 'any') {
          const matchedMaster = await db
            .prepare(
              `SELECT master_id FROM master_services WHERE service_id = ? LIMIT 1`
            )
            .bind(b.service_id)
            .first();
          if (matchedMaster?.master_id) {
            effectiveMasterId = matchedMaster.master_id;
            await db
              .prepare(`UPDATE bookings SET master_id = ? WHERE id = ?`)
              .bind(effectiveMasterId, b.id)
              .run();
          }
        }
        if (effectiveMasterId && effectiveMasterId !== 'any') {
          const startM = Number(b.start_minute);
          const endM = Number(b.end_minute);
          for (let m = startM; m < endM; m += SLOT_UNIT_MINUTES) {
            await db
              .prepare(
                `INSERT OR IGNORE INTO booked_slots (master_id, slot_date, slot_minute, booking_id)
                 VALUES (?, ?, ?, ?)`
              )
              .bind(effectiveMasterId, b.booking_date, m, b.id)
              .run();
          }
        }
      }
    } else {
      // В новой схеме заполняем client_first_name / client_last_name для записей, где был только client_name
      await db
        .prepare(
          `UPDATE bookings
           SET client_first_name = CASE
             WHEN client_first_name = '' AND INSTR(TRIM(client_name), ' ') > 0
               THEN SUBSTR(TRIM(client_name), 1, INSTR(TRIM(client_name), ' ') - 1)
             WHEN client_first_name = ''
               THEN TRIM(client_name)
             ELSE client_first_name
           END,
           client_last_name = CASE
             WHEN client_last_name = '' AND INSTR(TRIM(client_name), ' ') > 0
               THEN TRIM(SUBSTR(TRIM(client_name), INSTR(TRIM(client_name), ' ') + 1))
             ELSE client_last_name
           END
           WHERE client_first_name = '' AND client_name != ''`
        )
        .run();
    }

    // 5. Проверяем колонки notification_logs (в старой схеме не было channel, attempt, http_status, error_code, created_at)
    const notifLogCols = await getTableColumns(db, 'notification_logs');
    if (notifLogCols.size > 0) {
      if (!notifLogCols.has('channel')) {
        await db
          .prepare(`ALTER TABLE notification_logs ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'`)
          .run();
      }
      if (!notifLogCols.has('attempt')) {
        await db
          .prepare(`ALTER TABLE notification_logs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`)
          .run();
      }
      if (!notifLogCols.has('http_status')) {
        await db.prepare(`ALTER TABLE notification_logs ADD COLUMN http_status INTEGER`).run();
      }
      if (!notifLogCols.has('error_code')) {
        await db
          .prepare(`ALTER TABLE notification_logs ADD COLUMN error_code TEXT NOT NULL DEFAULT ''`)
          .run();
      }
      if (!notifLogCols.has('created_at')) {
        await db
          .prepare(`ALTER TABLE notification_logs ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`)
          .run();
        if (notifLogCols.has('attempted_at')) {
          await db
            .prepare(`UPDATE notification_logs SET created_at = attempted_at WHERE created_at = ''`)
            .run();
        }
      }
    }

    // 6. Если база была абсолютно пустой (нет ни одной услуги и ни одного мастера), заполняем базовый каталог LÉA STUDIO
    const srvCountRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM services`).first();
    if (!srvCountRow || Number(srvCountRow.cnt) === 0) {
      await seedInitialCatalogIfEmpty(db);
    }

    const compatInfo = { hasLegacyBookingColumns };
    initializedDatabases.add(db);
    dbLegacyColumnsCache.set(db, compatInfo);
    return compatInfo;
  } catch (err) {
    console.error('[DB Compat Check Warning]', err && err.message ? err.message : err);
    return { hasLegacyBookingColumns: false };
  }
}

async function seedInitialCatalogIfEmpty(db) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO salon_settings (key, value, description) VALUES
        ('salon_name', 'LÉA STUDIO', 'Название салона'),
        ('is_demo_data', 'true', 'Признак стартовых данных'),
        ('timezone', 'Europe/Moscow', 'Часовой пояс салона'),
        ('timezone_offset_minutes', '180', 'Смещение часового пояса от UTC в минутах'),
        ('min_lead_minutes', '30', 'Минимальное время до начала записи'),
        ('slot_step_minutes', '30', 'Шаг сетки слотов'),
        ('hold_ttl_seconds', '300', 'Время удержания слота'),
        ('booking_horizon_days', '45', 'Горизонт записи в днях')`
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO service_categories (id, title, subtitle, sort_order, is_active) VALUES
        ('manicure', 'Маникюр', 'Атравматичный уход за кутикулой, архитектура и стойкие покрытия', 1, 1),
        ('pedicure', 'Педикюр', 'SMART-обработка стоп, эстетика и спа-ритуалы расслабления', 2, 1),
        ('brows_lashes', 'Брови и ресницы', 'Естественная геометрия взгляда, бережное ламинирование и уход', 3, 1),
        ('facial_care', 'Уход за лицом', 'Эстетическая косметология, лимфодренажные массажи и гидробаланс', 4, 1),
        ('hair_styling', 'Укладки и причёски', 'Воздушные дневные укладки, вечерние текстуры и молекулярный уход', 5, 1)`
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO services (id, category_id, title, description, duration_minutes, price_rub, is_active, is_demo, sort_order) VALUES
        ('srv_mani_naked', 'manicure', 'Японский эко-маникюр P.Shine (без покрытия)', 'Деликатная обработка кутикулы и втирание минеральной пасты с жемчужной пудрой.', 60, 2600, 1, 1, 10),
        ('srv_mani_gel', 'manicure', 'Комплексный маникюр с выравниванием и покрытием гель-лак', 'Снятие старого покрытия, комбинированная обработка, архитектура и покрытие.', 90, 3400, 1, 1, 20),
        ('srv_mani_french', 'manicure', 'Архитектурный маникюр French / Микрофренч', 'Тонкая графичная линия улыбки на камуфлирующей молочной или нюдовой основе.', 105, 3900, 1, 1, 30),
        ('srv_pedi_smart', 'pedicure', 'Эстетический SMART-педикюр с покрытием', 'Атравматичная полировка стоп молекулярным маслом и стойкое покрытие.', 90, 4200, 1, 1, 40),
        ('srv_pedi_spa', 'pedicure', 'SPA-педикюр «Шёлковое прикосновение» без покрытия', 'Гигиенический уход в кресле-реклайнере, энзимный пилинг и массаж стоп.', 75, 3800, 1, 1, 50),
        ('srv_brow_arch', 'brows_lashes', 'Архитектура и деликатное окрашивание бровей', 'Построение естественной формы по анатомии лица и мягкое тонирование.', 45, 2200, 1, 1, 60),
        ('srv_brow_lami', 'brows_lashes', 'Ламинирование бровей с протеиновым уходом', 'Долговременная укладка волосков с глубоким питанием.', 60, 3100, 1, 1, 70),
        ('srv_lash_lami', 'brows_lashes', 'Ламинирование и ботокс ресниц Velvet Lift', 'Изящный изгиб от корней и уплотнение структуры натуральных ресниц.', 60, 3500, 1, 1, 80),
        ('srv_face_sculpt', 'facial_care', 'Скульптурно-буккальный массаж лица и зоны декольте', 'Глубокая миофасциальная проработка мышц лица для снятия зажимов.', 60, 4800, 1, 1, 90),
        ('srv_face_glow', 'facial_care', 'Детокс-ритуал «Фарфовое сияние» (Hydro-Glow)', 'Мягкое ультразвуковое очищение и альгинатная маска с дамасской розой.', 90, 6200, 1, 1, 100),
        ('srv_hair_blowout', 'hair_styling', 'Дневная воздушная укладка на брашинг или стайлер', 'Мытьё головы с массажем и создание подвижной объёмной текстуры.', 60, 3200, 1, 1, 110),
        ('srv_hair_evening', 'hair_styling', 'Вечерняя причёска или собранный пучок с уходом', 'Индивидуальный подбор силуэта и стойкая невесомая фиксация.', 90, 5400, 1, 1, 120)`
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO masters (id, name, role, specialization, bio, experience_years, portrait_key, is_active, is_demo, sort_order) VALUES
        ('mst_anna', 'Анна Сокова', 'Ведущий мастер ногтевого сервиса', 'Маникюр и SMART-педикюр', 'Специализируется на тонких ультра-натуральных покрытиях и японском эко-маникюре.', 7, 'anna', 1, 1, 1),
        ('mst_maria', 'Мария Лебедева', 'Топ-стилист взгляда', 'Архитектура бровей и ламинирование ресниц', 'Создаёт гармоничную, мягкую форму бровей без эффекта перегруженности.', 5, 'maria', 1, 1, 2),
        ('mst_elena', 'Елена Вернер', 'Косметолог-эстетист', 'Мануальные техники массажа и уход за кожей', 'Владеет европейскими методиками скульптурно-буккального моделирования.', 9, 'elena', 1, 1, 3),
        ('mst_sofia', 'София Корсакова', 'Стилист по волосам и nail-эстетист', 'Укладки, вечерние текстуры и маникюр', 'Мастер воздушных укладок, естественных локонов и экспресс-ритуалов.', 6, 'sofia', 1, 1, 4)`
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO master_services (master_id, service_id) VALUES
        ('mst_anna', 'srv_mani_naked'), ('mst_anna', 'srv_mani_gel'), ('mst_anna', 'srv_mani_french'),
        ('mst_anna', 'srv_pedi_smart'), ('mst_anna', 'srv_pedi_spa'),
        ('mst_maria', 'srv_brow_arch'), ('mst_maria', 'srv_brow_lami'), ('mst_maria', 'srv_lash_lami'),
        ('mst_elena', 'srv_face_sculpt'), ('mst_elena', 'srv_face_glow'), ('mst_elena', 'srv_lash_lami'),
        ('mst_sofia', 'srv_hair_blowout'), ('mst_sofia', 'srv_hair_evening'),
        ('mst_sofia', 'srv_mani_naked'), ('mst_sofia', 'srv_mani_gel')`
    )
    .run();

  const defaultSchedules = [
    ['mst_anna', 0, 1, 600, 1260, 780, 840],
    ['mst_anna', 1, 0, 600, 1260, null, null],
    ['mst_anna', 2, 1, 600, 1260, 780, 840],
    ['mst_anna', 3, 1, 600, 1260, 780, 840],
    ['mst_anna', 4, 1, 600, 1260, 780, 840],
    ['mst_anna', 5, 1, 600, 1260, 780, 840],
    ['mst_anna', 6, 1, 600, 1260, 780, 840],
    ['mst_maria', 0, 0, 600, 1200, null, null],
    ['mst_maria', 1, 1, 600, 1200, 840, 885],
    ['mst_maria', 2, 1, 600, 1200, 840, 885],
    ['mst_maria', 3, 1, 600, 1200, 840, 885],
    ['mst_maria', 4, 1, 600, 1200, 840, 885],
    ['mst_maria', 5, 1, 600, 1200, 840, 885],
    ['mst_maria', 6, 1, 600, 1200, 840, 885],
    ['mst_elena', 0, 1, 600, 1260, 900, 960],
    ['mst_elena', 1, 1, 600, 1260, 900, 960],
    ['mst_elena', 2, 0, 600, 1260, null, null],
    ['mst_elena', 3, 1, 600, 1260, 900, 960],
    ['mst_elena', 4, 1, 600, 1260, 900, 960],
    ['mst_elena', 5, 1, 600, 1260, 900, 960],
    ['mst_elena', 6, 1, 600, 1260, 900, 960],
    ['mst_sofia', 0, 1, 600, 1260, 810, 840],
    ['mst_sofia', 1, 1, 600, 1260, 810, 840],
    ['mst_sofia', 2, 1, 600, 1260, 810, 840],
    ['mst_sofia', 3, 1, 600, 1260, 810, 840],
    ['mst_sofia', 4, 1, 600, 1260, 810, 840],
    ['mst_sofia', 5, 1, 600, 1260, 810, 840],
    ['mst_sofia', 6, 1, 600, 1260, 810, 840],
  ];
  for (const row of defaultSchedules) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO master_schedules (
          master_id, day_of_week, is_working, start_minute, end_minute, break_start_minute, break_end_minute
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...row)
      .run();
  }
}

async function appendBookingAuditLog(db, bookingId, action, actor, details, nowIso) {
  try {
    await db
      .prepare(
        `INSERT INTO booking_audit_logs (booking_id, action, actor, details, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(bookingId, action, actor, details, nowIso || new Date().toISOString())
      .run();
  } catch {
    // Не прерываем основную операцию при ошибке записи истории
  }
}

async function loadSettingsMap(db) {
  const { results } = await db.prepare('SELECT key, value FROM salon_settings').all();
  const map = {};
  for (const row of results || []) {
    map[row.key] = row.value;
  }
  return map;
}

async function cleanupExpiredHolds(db, nowUnixSeconds) {
  await db
    .prepare('DELETE FROM slot_holds WHERE expires_at <= ?')
    .bind(nowUnixSeconds)
    .run();
}

async function getMasterDaySchedule(db, masterId, dateStr, dayOfWeek) {
  const exception = await db
    .prepare(
      'SELECT is_day_off, custom_start_minute, custom_end_minute, break_start_minute, break_end_minute, reason FROM master_exceptions WHERE master_id = ? AND exception_date = ?'
    )
    .bind(masterId, dateStr)
    .first();

  if (exception && Number(exception.is_day_off) === 1) {
    return {
      isWorking: false,
      reason: exception.reason || 'Выходной день мастера',
    };
  }

  const regular = await db
    .prepare(
      'SELECT is_working, start_minute, end_minute, break_start_minute, break_end_minute FROM master_schedules WHERE master_id = ? AND day_of_week = ?'
    )
    .bind(masterId, dayOfWeek)
    .first();

  if (!regular || (Number(regular.is_working) === 0 && !exception)) {
    return {
      isWorking: false,
      reason: 'Мастер не работает в этот день недели',
    };
  }

  const startMinute =
    exception && exception.custom_start_minute != null
      ? Number(exception.custom_start_minute)
      : Number(regular.start_minute);
  const endMinute =
    exception && exception.custom_end_minute != null
      ? Number(exception.custom_end_minute)
      : Number(regular.end_minute);
  const breakStartMinute =
    exception && exception.break_start_minute != null
      ? Number(exception.break_start_minute)
      : regular.break_start_minute != null
      ? Number(regular.break_start_minute)
      : null;
  const breakEndMinute =
    exception && exception.break_end_minute != null
      ? Number(exception.break_end_minute)
      : regular.break_end_minute != null
      ? Number(regular.break_end_minute)
      : null;

  return {
    isWorking: true,
    startMinute,
    endMinute,
    breakStartMinute,
    breakEndMinute,
  };
}

function checkMasterIntervalAvailability({
  startMinute,
  endMinute,
  schedule,
  bookedSlotsSet,
  heldSlotsSet,
  isToday,
  currentSalonMinute,
  minLeadMinutes,
}) {
  if (!schedule || !schedule.isWorking) {
    return { available: false, reason: 'day_off' };
  }

  if (startMinute < schedule.startMinute || endMinute > schedule.endMinute) {
    return { available: false, reason: 'outside_working_hours' };
  }

  if (isToday && startMinute < currentSalonMinute + minLeadMinutes) {
    return { available: false, reason: 'past_or_too_soon' };
  }

  if (
    schedule.breakStartMinute != null &&
    schedule.breakEndMinute != null &&
    startMinute < schedule.breakEndMinute &&
    endMinute > schedule.breakStartMinute
  ) {
    return { available: false, reason: 'break' };
  }

  for (let m = startMinute; m < endMinute; m += SLOT_UNIT_MINUTES) {
    if (bookedSlotsSet.has(m)) {
      return { available: false, reason: 'booked' };
    }
  }

  for (let m = startMinute; m < endMinute; m += SLOT_UNIT_MINUTES) {
    if (heldSlotsSet.has(m)) {
      return { available: false, reason: 'held' };
    }
  }

  return { available: true, reason: 'available' };
}

function sanitizeTelegramError(rawMsg, botToken) {
  let msg = String(rawMsg || 'Unknown Telegram error');
  if (botToken && botToken.length > 3) {
    msg = msg.split(botToken).join('[REDACTED]');
  }
  msg = msg.replace(/bot[0-9]+:[A-Za-z0-9_-]+/gi, 'bot[REDACTED]');
  return msg.slice(0, 240);
}

export function formatTelegramBookingMessage(bookingRecord, serviceTitle, masterName, eventType = 'new') {
  const commentText =
    bookingRecord.client_comment && String(bookingRecord.client_comment).trim()
      ? String(bookingRecord.client_comment).trim()
      : 'нет';
  const priceFormatted = Number(bookingRecord.price_rub).toLocaleString('ru-RU');

  let header = '🔔 Новая запись — LÉA STUDIO';
  if (eventType === 'cancelled') {
    header = '❌ Запись отменена — LÉA STUDIO';
  } else if (eventType === 'rescheduled') {
    header = '🔄 Запись перенесена — LÉA STUDIO';
  }

  const lines = [
    header,
    '',
    `👤 Клиент: ${bookingRecord.client_name}`,
    '',
    `📞 Телефон: ${bookingRecord.client_phone}`,
    '',
    `💅 Услуга: ${serviceTitle}`,
    '',
    `👩💼 Мастер: ${masterName}`,
    '',
    `📅 Дата: ${bookingRecord.booking_date}`,
    '',
    `🕒 Время: ${bookingRecord.start_time}–${bookingRecord.end_time}`,
    '',
    `⏱ Продолжительность: ${bookingRecord.duration_minutes} мин.`,
    '',
    `💰 Стоимость: ${priceFormatted} ₽`,
    '',
    `📝 Комментарий: ${commentText}`,
    '',
    `🆔 Номер записи: ${bookingRecord.id}`,
  ];

  if (bookingRecord.previousSlotInfo) {
    lines.push('', `↩️ Прежнее время: ${bookingRecord.previousSlotInfo}`);
  }

  return lines.join('\n');
}

async function recordTelegramAttemptState(
  db,
  {
    bookingId,
    status,
    attemptNumber,
    nextRetryUnix = null,
    httpStatus = null,
    errorCode = '',
    errorMessage = '',
    nowIso,
    sentAtIso = null,
  }
) {
  const statements = [
    db
      .prepare(
        `UPDATE bookings
         SET notification_status = ?,
             telegram_status = ?,
             telegram_attempts = ?,
             telegram_last_error = ?
         WHERE id = ?`
      )
      .bind(status, status, attemptNumber, errorMessage || errorCode || '', bookingId),
    db
      .prepare(
        `UPDATE notification_queue
         SET channel = 'telegram',
             status = ?,
             attempts = ?,
             next_retry_at = ?,
             last_http_status = ?,
             last_error_code = ?,
             updated_at = ?,
             sent_at = COALESCE(?, sent_at)
         WHERE booking_id = ?`
      )
      .bind(
        status,
        attemptNumber,
        nextRetryUnix,
        httpStatus,
        errorCode,
        nowIso,
        sentAtIso,
        bookingId
      ),
    db
      .prepare(
        `INSERT INTO notification_logs (
           booking_id, channel, status, attempt, http_status, error_code, error_message, created_at
         ) VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        bookingId,
        status,
        attemptNumber,
        httpStatus,
        errorCode,
        errorMessage,
        nowIso
      ),
  ];

  await db.batch(statements);
}

async function sendTelegramNotificationForBooking(
  env,
  bookingRecord,
  serviceTitle,
  masterName,
  currentAttempts = 0,
  maxAttempts = DEFAULT_MAX_NOTIFICATION_ATTEMPTS,
  eventType = 'new'
) {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const botToken = env.TELEGRAM_BOT_TOKEN ? String(env.TELEGRAM_BOT_TOKEN).trim() : '';
  const chatId = env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID).trim() : '';
  const apiBaseUrl = (env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(
    /\/+$/,
    ''
  );
  const timeoutMs = Number(env.TELEGRAM_TIMEOUT_MS || DEFAULT_TELEGRAM_TIMEOUT_MS);

  if (!botToken || !chatId) {
    const missingCode =
      !botToken && !chatId
        ? 'TELEGRAM_SECRETS_NOT_CONFIGURED'
        : !botToken
        ? 'TELEGRAM_BOT_TOKEN_MISSING'
        : 'TELEGRAM_CHAT_ID_MISSING';

    const missingMsg =
      !botToken && !chatId
        ? 'Не заданы секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID'
        : !botToken
        ? 'Не задан секрет TELEGRAM_BOT_TOKEN'
        : 'Не задан секрет TELEGRAM_CHAT_ID';

    if (eventType === 'new') {
      await recordTelegramAttemptState(db, {
        bookingId: bookingRecord.id,
        status: 'awaiting_configuration',
        attemptNumber: currentAttempts,
        nextRetryUnix: null,
        httpStatus: null,
        errorCode: missingCode,
        errorMessage: missingMsg,
        nowIso,
      });
    }

    return {
      sent: false,
      status: 'awaiting_configuration',
      code: missingCode,
    };
  }

  const attemptNumber = currentAttempts + 1;
  const messageText = formatTelegramBookingMessage(
    bookingRecord,
    serviceTitle,
    masterName,
    eventType
  );
  const endpointUrl = `${apiBaseUrl}/bot${botToken}/sendMessage`;

  const controller = new AbortController();
  const timerId = setTimeout(
    () => controller.abort(new Error('TELEGRAM_TIMEOUT')),
    timeoutMs
  );

  try {
    const fetchFn = env.__TEST_TELEGRAM_FETCH || fetch;
    const response = await fetchFn(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
      }),
      signal: controller.signal,
    });

    clearTimeout(timerId);

    const statusCode = Number(response.status || 0);
    let rawBody = '';
    try {
      rawBody = await response.text();
    } catch {
      rawBody = '';
    }

    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      const reachedLimit = attemptNumber >= maxAttempts;
      const nextStatus = reachedLimit ? 'failed_permanent' : 'failed_retry_scheduled';
      const errorCode = reachedLimit
        ? 'TELEGRAM_MAX_ATTEMPTS_EXCEEDED'
        : 'TELEGRAM_INVALID_JSON';
      const nextRetryUnix = reachedLimit
        ? null
        : Math.floor(Date.now() / 1000) + 120 * Math.pow(2, currentAttempts);

      if (eventType === 'new') {
        await recordTelegramAttemptState(db, {
          bookingId: bookingRecord.id,
          status: nextStatus,
          attemptNumber,
          nextRetryUnix,
          httpStatus: statusCode || null,
          errorCode,
          errorMessage: 'Ответ сервера Telegram не является корректным JSON',
          nowIso,
        });
      }

      return {
        sent: false,
        status: nextStatus,
        httpStatus: statusCode,
        code: errorCode,
      };
    }

    if (response.ok && parsedBody && parsedBody.ok === true) {
      if (eventType === 'new') {
        await recordTelegramAttemptState(db, {
          bookingId: bookingRecord.id,
          status: 'sent',
          attemptNumber,
          nextRetryUnix: null,
          httpStatus: statusCode,
          errorCode: '',
          errorMessage: '',
          nowIso,
          sentAtIso: nowIso,
        });
      } else {
        await db
          .prepare(
            `INSERT INTO notification_logs (
               booking_id, channel, status, attempt, http_status, error_code, error_message, created_at
             ) VALUES (?, 'telegram', 'sent', 1, ?, '', ?, ?)`
          )
          .bind(bookingRecord.id, statusCode, `Event: ${eventType}`, nowIso)
          .run();
      }

      return { sent: true, status: 'sent', httpStatus: statusCode };
    }

    const tgDescription =
      parsedBody && typeof parsedBody.description === 'string'
        ? sanitizeTelegramError(parsedBody.description, botToken)
        : `HTTP ${statusCode}`;

    const isApiOkFalse = parsedBody && parsedBody.ok === false;
    const tgErrorCodeNum = Number(parsedBody?.error_code || statusCode || 500);
    const isPermanentHttp =
      tgErrorCodeNum === 400 ||
      tgErrorCodeNum === 401 ||
      tgErrorCodeNum === 403 ||
      tgErrorCodeNum === 404;

    const reachedLimit = attemptNumber >= maxAttempts;
    const isPermanent = isPermanentHttp || reachedLimit;
    const nextStatus = isPermanent ? 'failed_permanent' : 'failed_retry_scheduled';

    let errorCode = isApiOkFalse
      ? 'TELEGRAM_API_OK_FALSE'
      : `TELEGRAM_HTTP_${statusCode || 500}`;
    if (reachedLimit && !isPermanentHttp) {
      errorCode = 'TELEGRAM_MAX_ATTEMPTS_EXCEEDED';
    }

    const nextRetryUnix = isPermanent
      ? null
      : Math.floor(Date.now() / 1000) + 120 * Math.pow(2, currentAttempts);

    if (eventType === 'new') {
      await recordTelegramAttemptState(db, {
        bookingId: bookingRecord.id,
        status: nextStatus,
        attemptNumber,
        nextRetryUnix,
        httpStatus: statusCode || tgErrorCodeNum,
        errorCode,
        errorMessage: `${errorCode}: ${tgDescription}`,
        nowIso,
      });
    }

    return {
      sent: false,
      status: nextStatus,
      httpStatus: statusCode || tgErrorCodeNum,
      code: errorCode,
    };
  } catch (err) {
    clearTimeout(timerId);

    const errName = String(err?.name || '');
    const errMsgRaw = String(err?.message || err || '');
    const isTimeout =
      errName === 'AbortError' ||
      errName === 'TimeoutError' ||
      errMsgRaw.includes('TELEGRAM_TIMEOUT') ||
      errMsgRaw.toLowerCase().includes('timeout') ||
      errMsgRaw.toLowerCase().includes('aborted');

    const reachedLimit = attemptNumber >= maxAttempts;
    const nextStatus = reachedLimit ? 'failed_permanent' : 'failed_retry_scheduled';
    const baseErrorCode = isTimeout ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_NETWORK_ERROR';
    const errorCode = reachedLimit ? 'TELEGRAM_MAX_ATTEMPTS_EXCEEDED' : baseErrorCode;
    const nextRetryUnix = reachedLimit
      ? null
      : Math.floor(Date.now() / 1000) + 120 * Math.pow(2, currentAttempts);

    const safeMessage = sanitizeTelegramError(
      `${baseErrorCode}: ${errMsgRaw || 'Сетевая ошибка при обращении к Telegram Bot API'}`,
      botToken
    );

    if (eventType === 'new') {
      await recordTelegramAttemptState(db, {
        bookingId: bookingRecord.id,
        status: nextStatus,
        attemptNumber,
        nextRetryUnix,
        httpStatus: null,
        errorCode,
        errorMessage: safeMessage,
        nowIso,
      });
    }

    return {
      sent: false,
      status: nextStatus,
      code: errorCode,
    };
  }
}

async function processPendingNotifications(env) {
  const db = env.DB;
  await ensureDatabaseReady(db);
  const nowUnix = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `UPDATE notification_queue
       SET status = 'failed_permanent',
           last_error_code = CASE
             WHEN last_error_code = '' THEN 'TELEGRAM_MAX_ATTEMPTS_EXCEEDED'
             ELSE last_error_code
           END,
           next_retry_at = NULL,
           updated_at = ?
       WHERE status IN ('failed_retry_scheduled', 'pending')
         AND attempts >= max_attempts`
    )
    .bind(nowIso)
    .run();

  const { results } = await db
    .prepare(
      `SELECT n.booking_id, n.attempts, n.max_attempts,
              b.id, b.client_name, b.client_phone, b.client_comment,
              b.booking_date, b.start_time, b.end_time, b.duration_minutes, b.price_rub,
              COALESCE(s.title, b.service_id) AS service_title,
              COALESCE(m.name, b.master_id) AS master_name
       FROM notification_queue n
       JOIN bookings b ON b.id = n.booking_id
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN masters m ON m.id = b.master_id
       WHERE n.status IN ('failed_retry_scheduled', 'pending', 'awaiting_configuration')
         AND n.attempts < n.max_attempts
         AND (n.next_retry_at IS NULL OR n.next_retry_at <= ?)
         AND b.status = 'confirmed'
         AND COALESCE(b.is_demo, 0) = 0
       ORDER BY n.created_at ASC
       LIMIT 20`
    )
    .bind(nowUnix)
    .all();

  const summary = { processed: 0, sent: 0, rescheduled: 0, failedPermanent: 0 };
  for (const row of results || []) {
    summary.processed += 1;
    const outcome = await sendTelegramNotificationForBooking(
      env,
      row,
      row.service_title,
      row.master_name,
      Number(row.attempts || 0),
      Number(row.max_attempts || DEFAULT_MAX_NOTIFICATION_ATTEMPTS),
      'new'
    );
    if (outcome.sent) {
      summary.sent += 1;
    } else if (outcome.status === 'failed_permanent') {
      summary.failedPermanent += 1;
    } else {
      summary.rescheduled += 1;
    }
  }
  return summary;
}

// ============================================================================
// ПУБЛИЧНЫЕ МАРШРУТЫ ОНЛАЙН-ЗАПИСИ
// ============================================================================

async function handleGetCatalog(env) {
  const db = env.DB;
  await ensureDatabaseReady(db);
  const settings = await loadSettingsMap(db);
  const offsetMinutes = Number(
    settings.timezone_offset_minutes || DEFAULT_TIMEZONE_OFFSET_MINUTES
  );
  const salonNow = getSalonNow(offsetMinutes, env);

  const [categoriesRes, servicesRes, mastersRes, masterServicesRes, schedulesRes] =
    await Promise.all([
      db
        .prepare(
          'SELECT id, title, subtitle, sort_order FROM service_categories WHERE is_active = 1 ORDER BY sort_order ASC'
        )
        .all(),
      db
        .prepare(
          'SELECT id, category_id, title, description, duration_minutes, price_rub, is_demo, sort_order FROM services WHERE is_active = 1 ORDER BY sort_order ASC'
        )
        .all(),
      db
        .prepare(
          'SELECT id, name, role, specialization, bio, experience_years, portrait_key, is_demo, sort_order FROM masters WHERE is_active = 1 ORDER BY sort_order ASC'
        )
        .all(),
      db.prepare('SELECT master_id, service_id FROM master_services').all(),
      db
        .prepare(
          'SELECT master_id, day_of_week, is_working, start_minute, end_minute, break_start_minute, break_end_minute FROM master_schedules'
        )
        .all(),
    ]);

  const masterServicesMap = {};
  for (const row of masterServicesRes.results || []) {
    if (!masterServicesMap[row.master_id]) {
      masterServicesMap[row.master_id] = [];
    }
    masterServicesMap[row.master_id].push(row.service_id);
  }

  const masterScheduleMap = {};
  for (const row of schedulesRes.results || []) {
    if (!masterScheduleMap[row.master_id]) {
      masterScheduleMap[row.master_id] = {};
    }
    masterScheduleMap[row.master_id][row.day_of_week] = {
      isWorking: Number(row.is_working) === 1,
      startTime: minutesToHHMM(Number(row.start_minute)),
      endTime: minutesToHHMM(Number(row.end_minute)),
      breakStart:
        row.break_start_minute != null
          ? minutesToHHMM(Number(row.break_start_minute))
          : null,
      breakEnd:
        row.break_end_minute != null
          ? minutesToHHMM(Number(row.break_end_minute))
          : null,
    };
  }

  const masters = (mastersRes.results || []).map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    specialization: m.specialization,
    bio: m.bio,
    experienceYears: Number(m.experience_years),
    portraitKey: m.portrait_key,
    isDemo: Number(m.is_demo) === 1,
    serviceIds: masterServicesMap[m.id] || [],
    weeklySchedule: masterScheduleMap[m.id] || {},
  }));

  const services = (servicesRes.results || []).map((s) => ({
    id: s.id,
    categoryId: s.category_id,
    title: s.title,
    description: s.description,
    durationMinutes: Number(s.duration_minutes),
    priceRub: Number(s.price_rub),
    isDemo: Number(s.is_demo) === 1,
  }));

  const telegramConfigured = Boolean(
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
  );

  return jsonResponse({
    ok: true,
    salon: {
      name: settings.salon_name || 'LÉA STUDIO',
      isDemoData: settings.is_demo_data !== 'false',
      timezone: settings.timezone || 'Europe/Moscow',
      timezoneOffsetMinutes: offsetMinutes,
      minLeadMinutes: Number(settings.min_lead_minutes || DEFAULT_MIN_LEAD_MINUTES),
      slotStepMinutes: Number(settings.slot_step_minutes || 30),
      holdTtlSeconds: Number(settings.hold_ttl_seconds || DEFAULT_HOLD_TTL_SECONDS),
      bookingHorizonDays: Number(settings.booking_horizon_days || DEFAULT_HORIZON_DAYS),
      addressPlaceholder: settings.address_placeholder || '',
      phonePlaceholder: settings.phone_placeholder || '',
      workHoursLabel: settings.work_hours_label || '',
      socials: {
        telegram: settings.telegram_url || '#configure-telegram-link',
        vk: settings.vk_url || '#configure-vk-link',
        whatsapp: settings.whatsapp_url || '#configure-whatsapp-link',
      },
      telegramBotConfigured: telegramConfigured,
      serverToday: salonNow.dateStr,
      serverTime: salonNow.timeStr,
    },
    categories: categoriesRes.results || [],
    services,
    masters,
  });
}

async function handleGetAvailability(request, env) {
  const url = new URL(request.url);
  const serviceId = (
    url.searchParams.get('serviceId') ||
    url.searchParams.get('service') ||
    ''
  ).trim();
  const masterId = (
    url.searchParams.get('masterId') ||
    url.searchParams.get('staff') ||
    'any'
  ).trim();
  const dateStr = (url.searchParams.get('date') || '').trim();
  const holdToken = (url.searchParams.get('holdToken') || '').trim();
  const excludeBookingId = (url.searchParams.get('excludeBookingId') || '').trim();

  if (!serviceId || !masterId || !dateStr) {
    return errorResponse(
      'MISSING_PARAMS',
      'Необходимо указать услугу (serviceId), мастера (masterId) и дату (date).',
      400
    );
  }

  const parsedDate = parseDateYMD(dateStr);
  if (!parsedDate) {
    return errorResponse('INVALID_DATE', 'Некорректный формат даты. Ожидается ГГГГ-ММ-ДД.', 400);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);
  const settings = await loadSettingsMap(db);
  const offsetMinutes = Number(
    settings.timezone_offset_minutes || DEFAULT_TIMEZONE_OFFSET_MINUTES
  );
  const minLeadMinutes = Number(
    settings.min_lead_minutes || DEFAULT_MIN_LEAD_MINUTES
  );
  const slotStepMinutes = Number(settings.slot_step_minutes || 30);
  const horizonDays = Number(settings.booking_horizon_days || DEFAULT_HORIZON_DAYS);

  const salonNow = getSalonNow(offsetMinutes, env);
  await cleanupExpiredHolds(db, salonNow.nowUnixSeconds);

  const dayDiff = diffDaysYMD(dateStr, salonNow.dateStr);
  if (dayDiff === null || dayDiff < 0) {
    return errorResponse(
      'PAST_DATE_FORBIDDEN',
      'Запись на прошедшие даты недоступна.',
      400
    );
  }
  if (dayDiff > horizonDays) {
    return errorResponse(
      'DATE_TOO_FAR',
      `Предварительная запись открыта на ${horizonDays} дней вперёд.`,
      400
    );
  }

  const service = await db
    .prepare(
      'SELECT id, title, duration_minutes, price_rub FROM services WHERE id = ? AND is_active = 1'
    )
    .bind(serviceId)
    .first();

  if (!service) {
    return errorResponse('SERVICE_NOT_FOUND', 'Выбранная услуга не найдена или недоступна.', 404);
  }
  const durationMinutes = Number(service.duration_minutes);

  let candidateMasters = [];
  if (masterId === 'any') {
    const { results } = await db
      .prepare(
        `SELECT m.id, m.name
         FROM masters m
         JOIN master_services ms ON ms.master_id = m.id
         WHERE ms.service_id = ? AND m.is_active = 1
         ORDER BY m.sort_order ASC`
      )
      .bind(serviceId)
      .all();
    candidateMasters = results || [];
    if (candidateMasters.length === 0) {
      return errorResponse(
        'NO_MASTERS_FOR_SERVICE',
        'Для выбранной услуги нет назначенных мастеров.',
        400
      );
    }
  } else {
    const masterRow = await db
      .prepare(
        `SELECT m.id, m.name
         FROM masters m
         JOIN master_services ms ON ms.master_id = m.id
         WHERE m.id = ? AND ms.service_id = ? AND m.is_active = 1`
      )
      .bind(masterId, serviceId)
      .first();

    if (!masterRow) {
      return errorResponse(
        'MASTER_SERVICE_MISMATCH',
        'Выбранный мастер не оказывает данную услугу.',
        400
      );
    }
    candidateMasters = [masterRow];
  }

  const masterStates = [];
  let minStartWindow = 24 * 60;
  let maxEndWindow = 0;

  for (const m of candidateMasters) {
    const schedule = await getMasterDaySchedule(
      db,
      m.id,
      dateStr,
      parsedDate.dayOfWeek
    );

    if (schedule.isWorking) {
      if (schedule.startMinute < minStartWindow) minStartWindow = schedule.startMinute;
      if (schedule.endMinute > maxEndWindow) maxEndWindow = schedule.endMinute;
    }

    const [bookedRes, activeBookingsRes, holdsRes] = await Promise.all([
      excludeBookingId
        ? db
            .prepare(
              'SELECT slot_minute FROM booked_slots WHERE master_id = ? AND slot_date = ? AND booking_id != ?'
            )
            .bind(m.id, dateStr, excludeBookingId)
            .all()
        : db
            .prepare(
              'SELECT slot_minute FROM booked_slots WHERE master_id = ? AND slot_date = ?'
            )
            .bind(m.id, dateStr)
            .all(),
      excludeBookingId
        ? db
            .prepare(
              `SELECT start_minute, end_minute FROM bookings
               WHERE booking_date = ? AND status IN ('confirmed', 'pending')
                 AND (master_id = ? OR master_id = 'any')
                 AND id != ?`
            )
            .bind(dateStr, m.id, excludeBookingId)
            .all()
        : db
            .prepare(
              `SELECT start_minute, end_minute FROM bookings
               WHERE booking_date = ? AND status IN ('confirmed', 'pending')
                 AND (master_id = ? OR master_id = 'any')`
            )
            .bind(dateStr, m.id)
            .all(),
      db
        .prepare(
          'SELECT slot_minute, hold_token FROM slot_holds WHERE master_id = ? AND slot_date = ? AND expires_at > ?'
        )
        .bind(m.id, dateStr, salonNow.nowUnixSeconds)
        .all(),
    ]);

    const bookedSlotsSet = new Set(
      (bookedRes.results || []).map((r) => Number(r.slot_minute))
    );
    for (const ab of activeBookingsRes.results || []) {
      const sMin = Number(ab.start_minute);
      const eMin = Number(ab.end_minute);
      for (let sm = sMin; sm < eMin; sm += SLOT_UNIT_MINUTES) {
        bookedSlotsSet.add(sm);
      }
    }

    const heldSlotsSet = new Set(
      (holdsRes.results || [])
        .filter((r) => !holdToken || r.hold_token !== holdToken)
        .map((r) => Number(r.slot_minute))
    );

    masterStates.push({
      masterId: m.id,
      masterName: m.name,
      schedule,
      bookedSlotsSet,
      heldSlotsSet,
    });
  }

  const anyWorkingMaster = masterStates.some((ms) => ms.schedule.isWorking);
  if (!anyWorkingMaster) {
    return jsonResponse({
      ok: true,
      date: dateStr,
      serviceId: service.id,
      durationMinutes,
      priceRub: Number(service.price_rub),
      isWorkingDay: false,
      dayOffReason:
        masterStates[0]?.schedule?.reason || 'В выбранный день приём не ведётся',
      slots: [],
    });
  }

  const isToday = dateStr === salonNow.dateStr;
  const slots = [];

  for (
    let startMin = minStartWindow;
    startMin + durationMinutes <= maxEndWindow;
    startMin += slotStepMinutes
  ) {
    const endMin = startMin + durationMinutes;
    const availableMasters = [];
    let primaryUnavailableReason = 'unavailable';
    const reasonsPriority = {
      booked: 4,
      held: 3,
      break: 2,
      past_or_too_soon: 1,
      outside_working_hours: 0,
      day_off: 0,
    };
    let bestPriority = -1;

    for (const ms of masterStates) {
      const check = checkMasterIntervalAvailability({
        startMinute: startMin,
        endMinute: endMin,
        schedule: ms.schedule,
        bookedSlotsSet: ms.bookedSlotsSet,
        heldSlotsSet: ms.heldSlotsSet,
        isToday,
        currentSalonMinute: salonNow.minuteOfDay,
        minLeadMinutes,
      });

      if (check.available) {
        availableMasters.push({ id: ms.masterId, name: ms.masterName });
      } else {
        const prio = reasonsPriority[check.reason] ?? 0;
        if (prio > bestPriority) {
          bestPriority = prio;
          primaryUnavailableReason = check.reason;
        }
      }
    }

    slots.push({
      time: minutesToHHMM(startMin),
      endTime: minutesToHHMM(endMin),
      startMinute: startMin,
      endMinute: endMin,
      available: availableMasters.length > 0,
      reason: availableMasters.length > 0 ? 'available' : primaryUnavailableReason,
      availableMastersCount: availableMasters.length,
      suggestedMaster: availableMasters[0] || null,
    });
  }

  return jsonResponse({
    ok: true,
    date: dateStr,
    serviceId: service.id,
    durationMinutes,
    priceRub: Number(service.price_rub),
    isWorkingDay: true,
    slots,
  });
}

async function handleCreateHold(request, env) {
  const rl = checkRateLimit(request);
  if (!rl.allowed) {
    return errorResponse(
      'TOO_MANY_REQUESTS',
      'Слишком много запросов. Пожалуйста, подождите минуту и попробуйте снова.',
      429
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный формат запроса.', 400);
  }

  const serviceId = String(body.serviceId || '').trim();
  const requestedMasterId = String(body.masterId || '').trim();
  const dateStr = String(body.date || '').trim();
  const timeStr = String(body.time || '').trim();
  const holdToken = String(body.holdToken || '').trim();

  if (!serviceId || !requestedMasterId || !dateStr || !timeStr || !holdToken) {
    return errorResponse('MISSING_FIELDS', 'Заполнены не все параметры удержания слота.', 400);
  }

  const parsedDate = parseDateYMD(dateStr);
  const startMinute = parseHHMMToMinutes(timeStr);
  if (!parsedDate || startMinute === null) {
    return errorResponse('INVALID_DATETIME', 'Некорректная дата или время.', 400);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);
  const settings = await loadSettingsMap(db);
  const offsetMinutes = Number(
    settings.timezone_offset_minutes || DEFAULT_TIMEZONE_OFFSET_MINUTES
  );
  const holdTtlSeconds = Number(
    settings.hold_ttl_seconds || DEFAULT_HOLD_TTL_SECONDS
  );
  const minLeadMinutes = Number(
    settings.min_lead_minutes || DEFAULT_MIN_LEAD_MINUTES
  );
  const salonNow = getSalonNow(offsetMinutes, env);

  await cleanupExpiredHolds(db, salonNow.nowUnixSeconds);

  const service = await db
    .prepare(
      'SELECT id, duration_minutes FROM services WHERE id = ? AND is_active = 1'
    )
    .bind(serviceId)
    .first();

  if (!service) {
    return errorResponse('SERVICE_NOT_FOUND', 'Услуга не найдена.', 404);
  }

  const durationMinutes = Number(service.duration_minutes);
  const endMinute = startMinute + durationMinutes;
  const endTimeStr = minutesToHHMM(endMinute);

  let candidates = [];
  if (requestedMasterId === 'any') {
    const { results } = await db
      .prepare(
        `SELECT m.id, m.name FROM masters m
         JOIN master_services ms ON ms.master_id = m.id
         WHERE ms.service_id = ? AND m.is_active = 1
         ORDER BY m.sort_order ASC`
      )
      .bind(serviceId)
      .all();
    candidates = results || [];
  } else {
    const m = await db
      .prepare(
        `SELECT m.id, m.name FROM masters m
         JOIN master_services ms ON ms.master_id = m.id
         WHERE m.id = ? AND ms.service_id = ? AND m.is_active = 1`
      )
      .bind(requestedMasterId, serviceId)
      .first();
    if (!m) {
      return errorResponse(
        'MASTER_SERVICE_MISMATCH',
        'Мастер не выполняет выбранную услугу.',
        400
      );
    }
    candidates = [m];
  }

  await db
    .prepare('DELETE FROM slot_holds WHERE hold_token = ?')
    .bind(holdToken)
    .run();

  const expiresAt = salonNow.nowUnixSeconds + holdTtlSeconds;
  const isToday = dateStr === salonNow.dateStr;

  for (const candidate of candidates) {
    const schedule = await getMasterDaySchedule(
      db,
      candidate.id,
      dateStr,
      parsedDate.dayOfWeek
    );
    const [bookedRes, holdsRes] = await Promise.all([
      db
        .prepare(
          'SELECT slot_minute FROM booked_slots WHERE master_id = ? AND slot_date = ?'
        )
        .bind(candidate.id, dateStr)
        .all(),
      db
        .prepare(
          'SELECT slot_minute, hold_token FROM slot_holds WHERE master_id = ? AND slot_date = ? AND expires_at > ?'
        )
        .bind(candidate.id, dateStr, salonNow.nowUnixSeconds)
        .all(),
    ]);

    const bookedSet = new Set(
      (bookedRes.results || []).map((r) => Number(r.slot_minute))
    );
    const heldSet = new Set(
      (holdsRes.results || [])
        .filter((r) => r.hold_token !== holdToken)
        .map((r) => Number(r.slot_minute))
    );

    const check = checkMasterIntervalAvailability({
      startMinute,
      endMinute,
      schedule,
      bookedSlotsSet: bookedSet,
      heldSlotsSet: heldSet,
      isToday,
      currentSalonMinute: salonNow.minuteOfDay,
      minLeadMinutes,
    });

    if (!check.available) continue;

    try {
      const stmts = [];
      for (let m = startMinute; m < endMinute; m += SLOT_UNIT_MINUTES) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO slot_holds (master_id, slot_date, slot_minute, hold_token, service_id, start_time, end_time, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              candidate.id,
              dateStr,
              m,
              holdToken,
              serviceId,
              timeStr,
              endTimeStr,
              expiresAt,
              salonNow.nowUnixSeconds
            )
        );
      }
      await db.batch(stmts);

      return jsonResponse({
        ok: true,
        hold: {
          holdToken,
          masterId: candidate.id,
          masterName: candidate.name,
          date: dateStr,
          startTime: timeStr,
          endTime: endTimeStr,
          expiresAt,
          ttlSeconds: holdTtlSeconds,
        },
      });
    } catch {
      // Переходим к следующему кандидату
    }
  }

  return errorResponse(
    'SLOT_ALREADY_TAKEN',
    SLOT_CONFLICT_MESSAGE_RU,
    409
  );
}

async function handleReleaseHold(request, env) {
  const db = env.DB;
  await ensureDatabaseReady(db);
  const url = new URL(request.url);
  const holdToken = (url.searchParams.get('holdToken') || '').trim();
  if (holdToken) {
    await db
      .prepare('DELETE FROM slot_holds WHERE hold_token = ?')
      .bind(holdToken)
      .run();
  }
  return jsonResponse({ ok: true });
}

async function handleCreateBooking(request, env) {
  const rl = checkRateLimit(request);
  if (!rl.allowed) {
    return errorResponse(
      'TOO_MANY_REQUESTS',
      'Превышен лимит запросов. Пожалуйста, подождите минуту и попробуйте снова.',
      429
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный формат JSON в теле запроса.', 400);
  }

  const headerIdempotencyKey =
    request.headers.get('X-Idempotency-Key') ||
    request.headers.get('Idempotency-Key') ||
    '';
  const idempotencyKey = String(
    body.idempotencyKey || headerIdempotencyKey || ''
  ).trim();
  const serviceId = String(body.serviceId || body.service || '').trim();
  const requestedMasterId = String(body.masterId || body.staffId || 'any').trim();
  const dateStr = String(body.date || body.bookingDate || '').trim();
  const timeStr = String(body.time || body.startTime || '').trim();

  const rawClientName = String(body.clientName || body.firstName || '').trim();
  const rawLastName = String(body.clientLastName || body.lastName || '').trim();
  const { firstName, lastName, fullName: clientName } = splitFullName(
    rawClientName,
    body.firstName || rawClientName,
    rawLastName
  );

  const rawPhone = String(body.clientPhone || body.phone || '').trim();
  const clientComment = String(body.clientComment || body.comment || '')
    .trim()
    .slice(0, 500);
  const holdToken = String(body.holdToken || '').trim();
  const consentAccepted = Boolean(body.consentAccepted ?? body.consent);

  if (!idempotencyKey || idempotencyKey.length < 6 || idempotencyKey.length > 128) {
    return errorResponse(
      'INVALID_IDEMPOTENCY_KEY',
      'Отсутствует корректный ключ защиты от повторной отправки (idempotencyKey).',
      400
    );
  }

  if (!serviceId || !requestedMasterId || !dateStr || !timeStr) {
    return errorResponse(
      'MISSING_BOOKING_PARAMS',
      'Выберите услугу, мастера, дату и время записи.',
      400
    );
  }

  if (firstName.length < 2 || clientName.length > 100) {
    return errorResponse(
      'INVALID_CLIENT_NAME',
      'Пожалуйста, укажите ваше имя (от 2 до 100 символов).',
      400
    );
  }

  const normalizedPhone = normalizePhone(rawPhone);
  if (!normalizedPhone) {
    return errorResponse(
      'INVALID_CLIENT_PHONE',
      'Укажите корректный номер телефона (например, +7 (999) 123-45-67).',
      400
    );
  }

  if (!consentAccepted) {
    return errorResponse(
      'CONSENT_REQUIRED',
      'Для оформления онлайн-записи необходимо согласие на обработку персональных данных.',
      400
    );
  }

  const parsedDate = parseDateYMD(dateStr);
  const startMinute = parseHHMMToMinutes(timeStr);
  if (!parsedDate || startMinute === null) {
    return errorResponse(
      'INVALID_DATETIME',
      'Некорректный формат даты или времени.',
      400
    );
  }

  const db = env.DB;
  const compat = await ensureDatabaseReady(db);

  // 1. Проверка идемпотентности (повторная отправка того же запроса)
  const existingByKey = await db
    .prepare(
      `SELECT b.id, b.service_id, b.master_id, b.booking_date, b.start_time, b.end_time,
              b.duration_minutes, b.price_rub, b.client_name, b.client_first_name, b.client_last_name,
              b.client_phone, b.client_comment,
              b.status, b.notification_status, b.telegram_status, b.telegram_attempts, b.telegram_last_error, b.created_at,
              COALESCE(s.title, b.service_id) AS service_title,
              COALESCE(m.name, b.master_id) AS master_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN masters m ON m.id = b.master_id
       WHERE b.idempotency_key = ?`
    )
    .bind(idempotencyKey)
    .first();

  if (existingByKey) {
    return jsonResponse({
      ok: true,
      idempotentReplay: true,
      booking: formatBookingResponse(existingByKey),
    });
  }

  const settings = await loadSettingsMap(db);
  const offsetMinutes = Number(
    settings.timezone_offset_minutes || DEFAULT_TIMEZONE_OFFSET_MINUTES
  );
  const minLeadMinutes = Number(
    settings.min_lead_minutes || DEFAULT_MIN_LEAD_MINUTES
  );
  const horizonDays = Number(settings.booking_horizon_days || DEFAULT_HORIZON_DAYS);

  const salonNow = getSalonNow(offsetMinutes, env);
  await cleanupExpiredHolds(db, salonNow.nowUnixSeconds);

  const dayDiff = diffDaysYMD(dateStr, salonNow.dateStr);
  if (dayDiff === null || dayDiff < 0) {
    return errorResponse(
      'PAST_DATE_FORBIDDEN',
      'Нельзя записаться на прошедшую дату.',
      400
    );
  }
  if (dayDiff > horizonDays) {
    return errorResponse(
      'DATE_TOO_FAR',
      `Запись доступна максимум на ${horizonDays} дней вперёд.`,
      400
    );
  }

  // 2. Авторитетная загрузка услуги с сервера
  const service = await db
    .prepare(
      'SELECT id, title, duration_minutes, price_rub FROM services WHERE id = ? AND is_active = 1'
    )
    .bind(serviceId)
    .first();

  if (!service) {
    return errorResponse('SERVICE_NOT_FOUND', 'Выбранная услуга не найдена.', 404);
  }

  const durationMinutes = Number(service.duration_minutes);
  const priceRub = Number(service.price_rub);
  const endMinute = startMinute + durationMinutes;
  const endTimeStr = minutesToHHMM(endMinute);

  if (dateStr === salonNow.dateStr && startMinute < salonNow.minuteOfDay + minLeadMinutes) {
    return errorResponse(
      'PAST_TIME_FORBIDDEN',
      'Выбранное время уже прошло или до начала визита осталось слишком мало времени.',
      400
    );
  }

  // 3. Определение подходящих мастеров
  let candidateMasters = [];
  if (requestedMasterId === 'any') {
    const { results } = await db
      .prepare(
        `SELECT m.id, m.name
         FROM masters m
         JOIN master_services ms ON ms.master_id = m.id
         WHERE ms.service_id = ? AND m.is_active = 1
         ORDER BY m.sort_order ASC`
      )
      .bind(serviceId)
      .all();
    candidateMasters = results || [];
    if (candidateMasters.length === 0) {
      return errorResponse(
        'NO_MASTERS_FOR_SERVICE',
        'Для выбранной услуги нет доступных мастеров.',
        400
      );
    }
  } else {
    const masterRow = await db
      .prepare(
        `SELECT m.id, m.name
         FROM masters m
         JOIN master_services ms ON ms.master_id = m.id
         WHERE m.id = ? AND ms.service_id = ? AND m.is_active = 1`
      )
      .bind(requestedMasterId, serviceId)
      .first();

    if (!masterRow) {
      return errorResponse(
        'MASTER_SERVICE_MISMATCH',
        'Выбранный мастер не оказывает данную услугу.',
        400
      );
    }
    candidateMasters = [masterRow];
  }

  let lastFailureReason = 'SLOT_CONFLICT';

  // 4. Попытка атомарного резервирования для кандидата
  for (const candidate of candidateMasters) {
    const schedule = await getMasterDaySchedule(
      db,
      candidate.id,
      dateStr,
      parsedDate.dayOfWeek
    );

    if (!schedule.isWorking) {
      lastFailureReason = 'MASTER_DAY_OFF';
      continue;
    }

    if (startMinute < schedule.startMinute || endMinute > schedule.endMinute) {
      lastFailureReason = 'OUTSIDE_WORKING_HOURS';
      continue;
    }

    if (
      schedule.breakStartMinute != null &&
      schedule.breakEndMinute != null &&
      startMinute < schedule.breakEndMinute &&
      endMinute > schedule.breakStartMinute
    ) {
      lastFailureReason = 'MASTER_ON_BREAK';
      continue;
    }

    const conflictingHold = await db
      .prepare(
        `SELECT hold_token FROM slot_holds
         WHERE master_id = ?
           AND slot_date = ?
           AND slot_minute >= ?
           AND slot_minute < ?
           AND expires_at > ?
           AND hold_token != ?
         LIMIT 1`
      )
      .bind(
        candidate.id,
        dateStr,
        startMinute,
        endMinute,
        salonNow.nowUnixSeconds,
        holdToken || '__NONE__'
      )
      .first();

    if (conflictingHold) {
      lastFailureReason = 'SLOT_TEMPORARILY_HELD';
      continue;
    }

    // Дополнительная проверка пересечения в таблице bookings (на случай записей без триггера в старой схеме)
    const overlappingBooking = await db
      .prepare(
        `SELECT id FROM bookings
         WHERE booking_date = ?
           AND status IN ('confirmed', 'pending')
           AND (master_id = ? OR master_id = 'any')
           AND start_minute < ?
           AND end_minute > ?
         LIMIT 1`
      )
      .bind(dateStr, candidate.id, endMinute, startMinute)
      .first();

    if (overlappingBooking) {
      lastFailureReason = 'SLOT_CONFLICT';
      continue;
    }

    const bookingId = generateBookingCode(dateStr);
    const notifId = `NTF-${bookingId}`;
    const createdAtIso = salonNow.nowIsoUtc;

    const batchStatements = [];

    if (holdToken) {
      batchStatements.push(
        db
          .prepare('DELETE FROM slot_holds WHERE hold_token = ?')
          .bind(holdToken)
      );
    }

    if (compat && compat.hasLegacyBookingColumns) {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO bookings (
              id, idempotency_key, first_name, last_name, phone,
              service_id, staff_id, master_id, booking_date,
              start_time, end_time, start_minutes, end_minutes, start_minute, end_minute,
              duration_minutes, price_rub, client_name, client_first_name, client_last_name,
              client_phone, client_comment, status, consent_accepted,
              notification_status, telegram_status, telegram_attempts, telegram_last_error, is_demo, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, 'pending', 'pending', 0, '', 0, ?)`
          )
          .bind(
            bookingId,
            idempotencyKey,
            firstName,
            lastName || '-',
            normalizedPhone,
            service.id,
            candidate.id,
            candidate.id,
            dateStr,
            timeStr,
            endTimeStr,
            startMinute,
            endMinute,
            startMinute,
            endMinute,
            durationMinutes,
            priceRub,
            clientName,
            firstName,
            lastName,
            normalizedPhone,
            clientComment,
            createdAtIso
          )
      );
    } else {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO bookings (
              id, idempotency_key, service_id, master_id, booking_date,
              start_time, end_time, start_minute, end_minute,
              duration_minutes, price_rub, client_name, client_first_name, client_last_name,
              client_phone, client_comment,
              status, notification_status, telegram_status, telegram_attempts, telegram_last_error, is_demo, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', 'pending', 0, '', 0, ?)`
          )
          .bind(
            bookingId,
            idempotencyKey,
            service.id,
            candidate.id,
            dateStr,
            timeStr,
            endTimeStr,
            startMinute,
            endMinute,
            durationMinutes,
            priceRub,
            clientName,
            firstName,
            lastName,
            normalizedPhone,
            clientComment,
            createdAtIso
          )
      );
    }

    for (let slotMin = startMinute; slotMin < endMinute; slotMin += SLOT_UNIT_MINUTES) {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO booked_slots (master_id, slot_date, slot_minute, booking_id)
             VALUES (?, ?, ?, ?)`
          )
          .bind(candidate.id, dateStr, slotMin, bookingId)
      );
    }

    batchStatements.push(
      db
        .prepare(
          `INSERT INTO notification_queue (
            id, booking_id, channel, status, attempts, max_attempts, created_at, updated_at
          ) VALUES (?, ?, 'telegram', 'pending', 0, ?, ?, ?)`
        )
        .bind(
          notifId,
          bookingId,
          DEFAULT_MAX_NOTIFICATION_ATTEMPTS,
          createdAtIso,
          createdAtIso
        )
    );

    batchStatements.push(
      db
        .prepare(
          `INSERT INTO booking_audit_logs (booking_id, action, actor, details, created_at)
           VALUES (?, 'created', 'client', ?, ?)`
        )
        .bind(
          bookingId,
          `Создана онлайн-запись: ${dateStr} ${timeStr}–${endTimeStr}, мастер ${candidate.name}`,
          createdAtIso
        )
    );

    try {
      await db.batch(batchStatements);

      const bookingRecord = {
        id: bookingId,
        service_id: service.id,
        service_title: service.title,
        master_id: candidate.id,
        master_name: candidate.name,
        booking_date: dateStr,
        start_time: timeStr,
        end_time: endTimeStr,
        duration_minutes: durationMinutes,
        price_rub: priceRub,
        client_name: clientName,
        client_first_name: firstName,
        client_last_name: lastName,
        client_phone: normalizedPhone,
        client_comment: clientComment,
        status: 'confirmed',
        notification_status: 'pending',
        telegram_status: 'pending',
        telegram_attempts: 0,
        telegram_last_error: '',
        created_at: createdAtIso,
      };

      const notifOutcome = await sendTelegramNotificationForBooking(
        env,
        bookingRecord,
        service.title,
        candidate.name,
        0,
        DEFAULT_MAX_NOTIFICATION_ATTEMPTS,
        'new'
      );
      bookingRecord.notification_status = notifOutcome.status;
      bookingRecord.telegram_status = notifOutcome.status;

      return jsonResponse(
        {
          ok: true,
          idempotentReplay: false,
          booking: formatBookingResponse(bookingRecord),
        },
        201
      );
    } catch (err) {
      const errMsg = String(err && err.message ? err.message : err);

      if (errMsg.includes('bookings.idempotency_key')) {
        const winner = await db
          .prepare(
            `SELECT b.id, b.service_id, b.master_id, b.booking_date, b.start_time, b.end_time,
                    b.duration_minutes, b.price_rub, b.client_name, b.client_first_name, b.client_last_name,
                    b.client_phone, b.client_comment,
                    b.status, b.notification_status, b.telegram_status, b.telegram_attempts, b.telegram_last_error, b.created_at,
                    COALESCE(s.title, b.service_id) AS service_title,
                    COALESCE(m.name, b.master_id) AS master_name
             FROM bookings b
             LEFT JOIN services s ON s.id = b.service_id
             LEFT JOIN masters m ON m.id = b.master_id
             WHERE b.idempotency_key = ?`
          )
          .bind(idempotencyKey)
          .first();

        if (winner) {
          return jsonResponse({
            ok: true,
            idempotentReplay: true,
            booking: formatBookingResponse(winner),
          });
        }
      }

      lastFailureReason = 'SLOT_CONFLICT';
    }
  }

  if (lastFailureReason === 'MASTER_DAY_OFF') {
    return errorResponse(
      'MASTER_DAY_OFF',
      'В выбранный день мастер не ведёт приём. Пожалуйста, выберите другую дату.',
      409
    );
  }
  if (lastFailureReason === 'OUTSIDE_WORKING_HOURS') {
    return errorResponse(
      'OUTSIDE_WORKING_HOURS',
      'Выбранное время или длительность услуги выходит за пределы рабочего графика мастера.',
      409
    );
  }
  if (lastFailureReason === 'MASTER_ON_BREAK') {
    return errorResponse(
      'MASTER_ON_BREAK',
      'Выбранный интервал пересекается с перерывом мастера. Выберите другое время.',
      409
    );
  }

  return errorResponse(
    'BOOKING_OVERLAP_CONFLICT',
    SLOT_CONFLICT_MESSAGE_RU,
    409
  );
}

function formatBookingResponse(row) {
  const notifStatus = row.telegram_status || row.notification_status || 'pending';
  const rawFull = row.client_name || `${row.first_name || ''} ${row.last_name || ''}`.trim();
  const { firstName, lastName, fullName } = splitFullName(
    rawFull,
    row.client_first_name || row.first_name || '',
    row.client_last_name || row.last_name || ''
  );

  return {
    id: row.id,
    serviceId: row.service_id,
    serviceTitle: row.service_title || row.service_id,
    masterId: row.master_id || row.staff_id || 'any',
    masterName: row.master_name || row.master_id || 'Мастер студии',
    date: row.booking_date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: Number(row.duration_minutes),
    priceRub: Number(row.price_rub),
    clientName: fullName,
    clientFirstName: firstName,
    clientLastName: lastName === '-' ? '' : lastName,
    clientPhone: row.client_phone || row.phone || '',
    clientComment: row.client_comment || '',
    status: row.status,
    notificationStatus: notifStatus,
    telegramStatus: notifStatus,
    telegramAttempts: Number(row.telegram_attempts || 0),
    telegramLastError: row.telegram_last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    cancelledAt: row.cancelled_at || null,
  };
}

// ============================================================================
// ЗАЩИЩЁННЫЕ АДМИНИСТРАТИВНЫЕ МАРШРУТЫ (/api/admin/*)
// ============================================================================

async function handleAdminLogin(request, env) {
  const rl = checkLoginRateLimit(request);
  if (!rl.allowed) {
    return errorResponse(
      'TOO_MANY_LOGIN_ATTEMPTS',
      'Превышено количество попыток входа. Подождите 5 минут перед повторной попыткой.',
      429
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный формат запроса.', 400);
  }

  const inputLogin = String(body.login || body.username || 'admin').trim();
  const inputPassword = String(body.password || '').trim();

  if (!inputPassword) {
    return errorResponse('MISSING_CREDENTIALS', 'Введите логин и пароль.', 400);
  }

  const expectedLogin = String(env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME).trim();
  const expectedHash = String(
    env.ADMIN_PASSWORD_SHA256 || DEFAULT_ADMIN_PASSWORD_SHA256
  )
    .trim()
    .toLowerCase();

  const actualHash = await sha256Hex(inputPassword);
  const loginMatches = inputLogin.toLowerCase() === expectedLogin.toLowerCase();
  const passwordMatches = timingSafeEqualHex(actualHash, expectedHash);

  if (!loginMatches || !passwordMatches) {
    recordFailedLoginAttempt(request);
    return errorResponse(
      'INVALID_CREDENTIALS',
      'Неверный логин или пароль администратора.',
      401
    );
  }

  clearLoginAttempts(request);
  const session = await createAdminSessionToken(env, expectedLogin);
  const cookieValue = `lea_admin_session=${encodeURIComponent(
    session.token
  )}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`;

  return jsonResponse(
    {
      ok: true,
      authenticated: true,
      admin: {
        login: session.login,
      },
      csrfToken: session.csrfToken,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    },
    200,
    {
      'Set-Cookie': cookieValue,
    }
  );
}

async function handleAdminLogout(request, env) {
  const auth = await authenticateAdminRequest(request, env, { requireCsrf: false });
  if (auth.token) {
    revokedSessionTokens.add(auth.token);
  }
  const clearCookie =
    'lea_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
  return jsonResponse(
    { ok: true, authenticated: false },
    200,
    { 'Set-Cookie': clearCookie }
  );
}

async function handleAdminSession(request, env) {
  const auth = await authenticateAdminRequest(request, env, { requireCsrf: false });
  if (!auth.authorized) {
    return errorResponse(
      'UNAUTHORIZED',
      'Сессия администратора не активна.',
      401
    );
  }
  return jsonResponse({
    ok: true,
    authenticated: true,
    admin: { login: auth.login },
    csrfToken: auth.csrfToken,
  });
}

async function handleAdminOverview(request, env) {
  const auth = await authenticateAdminRequest(request, env, { requireCsrf: false });
  if (!auth.authorized) {
    return errorResponse(
      'UNAUTHORIZED',
      'Требуется серверная авторизация администратора.',
      401
    );
  }

  const db = env.DB;
  await ensureDatabaseReady(db);
  const settings = await loadSettingsMap(db);
  const offsetMinutes = Number(
    settings.timezone_offset_minutes || DEFAULT_TIMEZONE_OFFSET_MINUTES
  );
  const salonNow = getSalonNow(offsetMinutes, env);

  const url = new URL(request.url);
  const filterDate = (url.searchParams.get('date') || '').trim();
  const filterMasterId = (url.searchParams.get('masterId') || '').trim();
  const filterServiceId = (url.searchParams.get('serviceId') || '').trim();
  const filterStatus = (url.searchParams.get('status') || '').trim();
  const searchQuery = (url.searchParams.get('search') || '').trim().toLowerCase();

  const [
    bookingsRes,
    queueRes,
    logsRes,
    auditRes,
    categoriesRes,
    servicesRes,
    mastersRes,
    masterServicesRes,
    schedulesRes,
    exceptionsRes,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT b.*,
                COALESCE(s.title, b.service_id) AS service_title,
                COALESCE(m.name, b.master_id) AS master_name
         FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id
         LEFT JOIN masters m ON m.id = b.master_id
         ORDER BY b.booking_date DESC, b.start_minute ASC
         LIMIT 500`
      )
      .all(),
    db
      .prepare(
        `SELECT id, booking_id, channel, status, attempts, max_attempts,
                next_retry_at, last_http_status, last_error_code, updated_at, sent_at
         FROM notification_queue
         ORDER BY updated_at DESC
         LIMIT 100`
      )
      .all(),
    db
      .prepare(
        `SELECT id, booking_id, channel, status, attempt, http_status, error_code, error_message, created_at
         FROM notification_logs
         ORDER BY id DESC
         LIMIT 100`
      )
      .all(),
    db
      .prepare(
        `SELECT id, booking_id, action, actor, details, created_at
         FROM booking_audit_logs
         ORDER BY id DESC
         LIMIT 300`
      )
      .all(),
    db
      .prepare('SELECT id, title, subtitle, sort_order, is_active FROM service_categories ORDER BY sort_order ASC')
      .all(),
    db
      .prepare(
        'SELECT id, category_id, title, description, duration_minutes, price_rub, is_active, is_demo, sort_order FROM services ORDER BY sort_order ASC'
      )
      .all(),
    db
      .prepare(
        'SELECT id, name, role, specialization, bio, experience_years, portrait_key, is_active, is_demo, sort_order FROM masters ORDER BY sort_order ASC'
      )
      .all(),
    db.prepare('SELECT master_id, service_id FROM master_services').all(),
    db
      .prepare(
        'SELECT master_id, day_of_week, is_working, start_minute, end_minute, break_start_minute, break_end_minute FROM master_schedules'
      )
      .all(),
    db
      .prepare(
        'SELECT id, master_id, exception_date, is_day_off, custom_start_minute, custom_end_minute, break_start_minute, break_end_minute, reason FROM master_exceptions ORDER BY exception_date ASC'
      )
      .all(),
  ]);

  const auditByBooking = {};
  for (const log of auditRes.results || []) {
    if (!auditByBooking[log.booking_id]) {
      auditByBooking[log.booking_id] = [];
    }
    auditByBooking[log.booking_id].push({
      id: log.id,
      action: log.action,
      actor: log.actor,
      details: log.details,
      createdAt: log.created_at,
    });
  }

  const allBookings = (bookingsRes.results || []).map((row) => ({
    ...formatBookingResponse(row),
    auditLogs: auditByBooking[row.id] || [],
  }));

  // Считаем сводные показатели по реальной базе данных
  const todayStr = salonNow.dateStr;
  let todayCount = 0;
  let upcomingCount = 0;
  let newCount = 0;
  let confirmedCount = 0;
  let cancelledCount = 0;
  const upcomingClients = [];

  for (const b of allBookings) {
    if (b.status === 'cancelled') {
      cancelledCount += 1;
    } else {
      confirmedCount += 1;
      if (b.status === 'pending') {
        newCount += 1;
      }
      if (b.date === todayStr) {
        todayCount += 1;
      }
      if (b.date >= todayStr) {
        upcomingCount += 1;
        upcomingClients.push(b);
      }
    }
  }
  upcomingClients.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });

  // Применяем серверные фильтры, если они переданы
  const filteredBookings = allBookings.filter((b) => {
    if (filterDate && b.date !== filterDate) return false;
    if (filterMasterId && filterMasterId !== 'all' && b.masterId !== filterMasterId) {
      return false;
    }
    if (filterServiceId && filterServiceId !== 'all' && b.serviceId !== filterServiceId) {
      return false;
    }
    if (filterStatus && filterStatus !== 'all' && b.status !== filterStatus) {
      return false;
    }
    if (searchQuery) {
      const hay = `${b.clientName} ${b.clientFirstName} ${b.clientLastName} ${b.clientPhone} ${b.id} ${b.serviceTitle} ${b.masterName}`.toLowerCase();
      const digitsQuery = searchQuery.replace(/\D/g, '');
      const digitsPhone = b.clientPhone.replace(/\D/g, '');
      const matchText = hay.includes(searchQuery);
      const matchDigits = digitsQuery.length >= 3 && digitsPhone.includes(digitsQuery);
      if (!matchText && !matchDigits) return false;
    }
    return true;
  });

  const masterServicesMap = {};
  for (const row of masterServicesRes.results || []) {
    if (!masterServicesMap[row.master_id]) masterServicesMap[row.master_id] = [];
    masterServicesMap[row.master_id].push(row.service_id);
  }

  const masterScheduleMap = {};
  for (const row of schedulesRes.results || []) {
    if (!masterScheduleMap[row.master_id]) masterScheduleMap[row.master_id] = {};
    masterScheduleMap[row.master_id][row.day_of_week] = {
      dayOfWeek: Number(row.day_of_week),
      isWorking: Number(row.is_working) === 1,
      startTime: minutesToHHMM(Number(row.start_minute)),
      endTime: minutesToHHMM(Number(row.end_minute)),
      breakStart:
        row.break_start_minute != null
          ? minutesToHHMM(Number(row.break_start_minute))
          : null,
      breakEnd:
        row.break_end_minute != null
          ? minutesToHHMM(Number(row.break_end_minute))
          : null,
    };
  }

  const masterExceptionsMap = {};
  for (const ex of exceptionsRes.results || []) {
    if (!masterExceptionsMap[ex.master_id]) masterExceptionsMap[ex.master_id] = [];
    masterExceptionsMap[ex.master_id].push({
      id: ex.id,
      date: ex.exception_date,
      isDayOff: Number(ex.is_day_off) === 1,
      customStart:
        ex.custom_start_minute != null
          ? minutesToHHMM(Number(ex.custom_start_minute))
          : null,
      customEnd:
        ex.custom_end_minute != null
          ? minutesToHHMM(Number(ex.custom_end_minute))
          : null,
      reason: ex.reason || '',
    });
  }

  const botTokenConfigured = Boolean(
    env.TELEGRAM_BOT_TOKEN && String(env.TELEGRAM_BOT_TOKEN).trim()
  );
  const chatIdConfigured = Boolean(
    env.TELEGRAM_CHAT_ID && String(env.TELEGRAM_CHAT_ID).trim()
  );

  return jsonResponse({
    ok: true,
    serverToday: todayStr,
    serverTime: salonNow.timeStr,
    csrfToken: auth.csrfToken,
    stats: {
      totalBookings: allBookings.length,
      todayCount,
      upcomingCount,
      newCount: newCount || todayCount,
      confirmedCount,
      cancelledCount,
      upcomingClients: upcomingClients.slice(0, 10),
    },
    telegramIntegration: {
      configured: botTokenConfigured && chatIdConfigured,
      botTokenConfigured,
      chatIdConfigured,
      apiEndpoint: 'https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage',
    },
    bookings: filteredBookings,
    allBookingsCount: allBookings.length,
    categories: categoriesRes.results || [],
    services: (servicesRes.results || []).map((s) => ({
      id: s.id,
      categoryId: s.category_id,
      title: s.title,
      description: s.description,
      durationMinutes: Number(s.duration_minutes),
      priceRub: Number(s.price_rub),
      isActive: Number(s.is_active) === 1,
      isDemo: Number(s.is_demo) === 1,
      sortOrder: Number(s.sort_order || 0),
    })),
    masters: (mastersRes.results || []).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      specialization: m.specialization,
      bio: m.bio,
      experienceYears: Number(m.experience_years),
      portraitKey: m.portrait_key,
      isActive: Number(m.is_active) === 1,
      isDemo: Number(m.is_demo) === 1,
      serviceIds: masterServicesMap[m.id] || [],
      weeklySchedule: masterScheduleMap[m.id] || {},
      exceptions: masterExceptionsMap[m.id] || [],
    })),
    notificationQueue: queueRes.results || [],
    notificationLogs: logsRes.results || [],
  });
}

async function handleAdminCancelBooking(request, env, bookingId) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);
  const existing = await db
    .prepare(
      `SELECT b.*,
              COALESCE(s.title, b.service_id) AS service_title,
              COALESCE(m.name, b.master_id) AS master_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN masters m ON m.id = b.master_id
       WHERE b.id = ?`
    )
    .bind(bookingId)
    .first();

  if (!existing) {
    return errorResponse('BOOKING_NOT_FOUND', 'Запись не найдена.', 404);
  }

  if (existing.status === 'cancelled') {
    return jsonResponse({
      ok: true,
      id: bookingId,
      status: 'cancelled',
      booking: formatBookingResponse(existing),
    });
  }

  const nowIso = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE bookings
         SET status = 'cancelled',
             cancelled_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(nowIso, nowIso, bookingId),
    db.prepare('DELETE FROM booked_slots WHERE booking_id = ?').bind(bookingId),
    db
      .prepare(
        `INSERT INTO booking_audit_logs (booking_id, action, actor, details, created_at)
         VALUES (?, 'cancelled', ?, ?, ?)`
      )
      .bind(
        bookingId,
        auth.login || 'admin',
        `Запись отменена администратором (${existing.booking_date} ${existing.start_time}–${existing.end_time})`,
        nowIso
      ),
  ]);

  existing.status = 'cancelled';
  existing.cancelled_at = nowIso;
  existing.updated_at = nowIso;

  await sendTelegramNotificationForBooking(
    env,
    existing,
    existing.service_title,
    existing.master_name,
    0,
    1,
    'cancelled'
  );

  return jsonResponse({
    ok: true,
    id: bookingId,
    status: 'cancelled',
    cancelledAt: nowIso,
    booking: formatBookingResponse(existing),
  });
}

async function handleAdminConfirmBooking(request, env, bookingId) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);
  const existing = await db
    .prepare(
      `SELECT b.*,
              COALESCE(s.title, b.service_id) AS service_title,
              COALESCE(m.name, b.master_id) AS master_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN masters m ON m.id = b.master_id
       WHERE b.id = ?`
    )
    .bind(bookingId)
    .first();

  if (!existing) {
    return errorResponse('BOOKING_NOT_FOUND', 'Запись не найдена.', 404);
  }

  if (existing.status === 'confirmed') {
    return jsonResponse({
      ok: true,
      id: bookingId,
      status: 'confirmed',
      booking: formatBookingResponse(existing),
    });
  }

  const startMin = Number(existing.start_minute);
  const endMin = Number(existing.end_minute);
  const masterId = existing.master_id;
  const dateStr = existing.booking_date;

  // Проверяем, не занят ли интервал другой активной записью перед восстановлением/подтверждением
  const conflict = await db
    .prepare(
      `SELECT booking_id FROM booked_slots
       WHERE master_id = ? AND slot_date = ? AND slot_minute >= ? AND slot_minute < ? AND booking_id != ?
       LIMIT 1`
    )
    .bind(masterId, dateStr, startMin, endMin, bookingId)
    .first();

  if (conflict) {
    return errorResponse(
      'BOOKING_OVERLAP_CONFLICT',
      SLOT_CONFLICT_MESSAGE_RU,
      409
    );
  }

  const nowIso = new Date().toISOString();
  const stmts = [
    db
      .prepare(
        `UPDATE bookings
         SET status = 'confirmed',
             cancelled_at = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(nowIso, bookingId),
  ];

  for (let m = startMin; m < endMin; m += SLOT_UNIT_MINUTES) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO booked_slots (master_id, slot_date, slot_minute, booking_id)
           VALUES (?, ?, ?, ?)`
        )
        .bind(masterId, dateStr, m, bookingId)
    );
  }

  stmts.push(
    db
      .prepare(
        `INSERT INTO booking_audit_logs (booking_id, action, actor, details, created_at)
         VALUES (?, 'confirmed', ?, ?, ?)`
      )
      .bind(
        bookingId,
        auth.login || 'admin',
        `Запись подтверждена администратором (${dateStr} ${existing.start_time}–${existing.end_time})`,
        nowIso
      )
  );

  try {
    await db.batch(stmts);
  } catch {
    return errorResponse('BOOKING_OVERLAP_CONFLICT', SLOT_CONFLICT_MESSAGE_RU, 409);
  }

  existing.status = 'confirmed';
  existing.cancelled_at = null;
  existing.updated_at = nowIso;

  return jsonResponse({
    ok: true,
    id: bookingId,
    status: 'confirmed',
    booking: formatBookingResponse(existing),
  });
}

async function handleAdminRescheduleBooking(request, env, bookingId) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный формат JSON.', 400);
  }

  const newDateStr = String(body.date || body.bookingDate || '').trim();
  const newTimeStr = String(body.time || body.startTime || '').trim();
  const newMasterIdInput = String(body.masterId || '').trim();

  const parsedDate = parseDateYMD(newDateStr);
  const newStartMinute = parseHHMMToMinutes(newTimeStr);
  if (!parsedDate || newStartMinute === null) {
    return errorResponse(
      'INVALID_DATETIME',
      'Укажите корректную новую дату (ГГГГ-ММ-ДД) и время (ЧЧ:ММ).',
      400
    );
  }

  const db = env.DB;
  const compat = await ensureDatabaseReady(db);

  const existing = await db
    .prepare(
      `SELECT b.*,
              COALESCE(s.title, b.service_id) AS service_title,
              COALESCE(m.name, b.master_id) AS master_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN masters m ON m.id = b.master_id
       WHERE b.id = ?`
    )
    .bind(bookingId)
    .first();

  if (!existing) {
    return errorResponse('BOOKING_NOT_FOUND', 'Запись не найдена.', 404);
  }

  const targetMasterId = newMasterIdInput || existing.master_id;
  const durationMinutes = Number(existing.duration_minutes);
  const newEndMinute = newStartMinute + durationMinutes;
  const newEndTimeStr = minutesToHHMM(newEndMinute);

  // Проверяем, что выбранный мастер оказывает услугу
  const masterRow = await db
    .prepare(
      `SELECT m.id, m.name
       FROM masters m
       JOIN master_services ms ON ms.master_id = m.id
       WHERE m.id = ? AND ms.service_id = ? AND m.is_active = 1`
    )
    .bind(targetMasterId, existing.service_id)
    .first();

  if (!masterRow) {
    return errorResponse(
      'MASTER_SERVICE_MISMATCH',
      'Выбранный мастер не оказывает данную услугу.',
      400
    );
  }

  // Проверяем рабочий график мастера на новую дату
  const schedule = await getMasterDaySchedule(
    db,
    targetMasterId,
    newDateStr,
    parsedDate.dayOfWeek
  );

  if (!schedule.isWorking) {
    return errorResponse(
      'MASTER_DAY_OFF',
      'В выбранный день мастер не работает.',
      409
    );
  }

  if (newStartMinute < schedule.startMinute || newEndMinute > schedule.endMinute) {
    return errorResponse(
      'OUTSIDE_WORKING_HOURS',
      'Новое время выходит за пределы рабочего расписания мастера.',
      409
    );
  }

  if (
    schedule.breakStartMinute != null &&
    schedule.breakEndMinute != null &&
    newStartMinute < schedule.breakEndMinute &&
    newEndMinute > schedule.breakStartMinute
  ) {
    return errorResponse(
      'MASTER_ON_BREAK',
      'Новое время пересекается с перерывом мастера.',
      409
    );
  }

  // Проверяем отсутствие конфликтов с другими записями на новом интервале
  const slotConflict = await db
    .prepare(
      `SELECT booking_id FROM booked_slots
       WHERE master_id = ?
         AND slot_date = ?
         AND slot_minute >= ?
         AND slot_minute < ?
         AND booking_id != ?
       LIMIT 1`
    )
    .bind(targetMasterId, newDateStr, newStartMinute, newEndMinute, bookingId)
    .first();

  if (slotConflict) {
    return errorResponse(
      'BOOKING_OVERLAP_CONFLICT',
      SLOT_CONFLICT_MESSAGE_RU,
      409
    );
  }

  const bookingConflict = await db
    .prepare(
      `SELECT id FROM bookings
       WHERE booking_date = ?
         AND status IN ('confirmed', 'pending')
         AND master_id = ?
         AND id != ?
         AND start_minute < ?
         AND end_minute > ?
       LIMIT 1`
    )
    .bind(newDateStr, targetMasterId, bookingId, newEndMinute, newStartMinute)
    .first();

  if (bookingConflict) {
    return errorResponse(
      'BOOKING_OVERLAP_CONFLICT',
      SLOT_CONFLICT_MESSAGE_RU,
      409
    );
  }

  const nowIso = new Date().toISOString();
  const previousSlotInfo = `${existing.booking_date} ${existing.start_time}–${existing.end_time} (${existing.master_name})`;

  const stmts = [
    db.prepare('DELETE FROM booked_slots WHERE booking_id = ?').bind(bookingId),
  ];

  if (compat && compat.hasLegacyBookingColumns) {
    stmts.push(
      db
        .prepare(
          `UPDATE bookings
           SET master_id = ?,
               staff_id = ?,
               booking_date = ?,
               start_time = ?,
               end_time = ?,
               start_minute = ?,
               end_minute = ?,
               start_minutes = ?,
               end_minutes = ?,
               status = 'confirmed',
               cancelled_at = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          targetMasterId,
          targetMasterId,
          newDateStr,
          newTimeStr,
          newEndTimeStr,
          newStartMinute,
          newEndMinute,
          newStartMinute,
          newEndMinute,
          nowIso,
          bookingId
        )
    );
  } else {
    stmts.push(
      db
        .prepare(
          `UPDATE bookings
           SET master_id = ?,
               booking_date = ?,
               start_time = ?,
               end_time = ?,
               start_minute = ?,
               end_minute = ?,
               status = 'confirmed',
               cancelled_at = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          targetMasterId,
          newDateStr,
          newTimeStr,
          newEndTimeStr,
          newStartMinute,
          newEndMinute,
          nowIso,
          bookingId
        )
    );
  }

  for (let m = newStartMinute; m < newEndMinute; m += SLOT_UNIT_MINUTES) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO booked_slots (master_id, slot_date, slot_minute, booking_id)
           VALUES (?, ?, ?, ?)`
        )
        .bind(targetMasterId, newDateStr, m, bookingId)
    );
  }

  stmts.push(
    db
      .prepare(
        `INSERT INTO booking_audit_logs (booking_id, action, actor, details, created_at)
         VALUES (?, 'rescheduled', ?, ?, ?)`
      )
      .bind(
        bookingId,
        auth.login || 'admin',
        `Перенос с ${previousSlotInfo} на ${newDateStr} ${newTimeStr}–${newEndTimeStr} (${masterRow.name})`,
        nowIso
      )
  );

  try {
    await db.batch(stmts);
  } catch {
    return errorResponse(
      'BOOKING_OVERLAP_CONFLICT',
      SLOT_CONFLICT_MESSAGE_RU,
      409
    );
  }

  const updatedRecord = {
    ...existing,
    master_id: targetMasterId,
    master_name: masterRow.name,
    booking_date: newDateStr,
    start_time: newTimeStr,
    end_time: newEndTimeStr,
    start_minute: newStartMinute,
    end_minute: newEndMinute,
    status: 'confirmed',
    cancelled_at: null,
    updated_at: nowIso,
    previousSlotInfo,
  };

  await sendTelegramNotificationForBooking(
    env,
    updatedRecord,
    existing.service_title,
    masterRow.name,
    0,
    1,
    'rescheduled'
  );

  return jsonResponse({
    ok: true,
    booking: formatBookingResponse(updatedRecord),
  });
}

async function handleAdminStatusChange(request, env, bookingId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный JSON.', 400);
  }

  const nextStatus = String(body.status || '').trim();
  if (nextStatus === 'cancelled') {
    return handleAdminCancelBooking(request, env, bookingId);
  }
  if (nextStatus === 'confirmed') {
    return handleAdminConfirmBooking(request, env, bookingId);
  }

  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  if (!['pending', 'completed'].includes(nextStatus)) {
    return errorResponse('INVALID_STATUS', 'Недопустимый статус записи.', 400);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);
  const nowIso = new Date().toISOString();

  await db.batch([
    db
      .prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(nextStatus, nowIso, bookingId),
    db
      .prepare(
        `INSERT INTO booking_audit_logs (booking_id, action, actor, details, created_at)
         VALUES (?, 'status_changed', ?, ?, ?)`
      )
      .bind(
        bookingId,
        auth.login || 'admin',
        `Статус изменён на «${nextStatus}»`,
        nowIso
      ),
  ]);

  const updated = await db
    .prepare(
      `SELECT b.*,
              COALESCE(s.title, b.service_id) AS service_title,
              COALESCE(m.name, b.master_id) AS master_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN masters m ON m.id = b.master_id
       WHERE b.id = ?`
    )
    .bind(bookingId)
    .first();

  if (!updated) {
    return errorResponse('BOOKING_NOT_FOUND', 'Запись не найдена.', 404);
  }

  return jsonResponse({
    ok: true,
    booking: formatBookingResponse(updated),
  });
}

// ============================================================================
// УПРАВЛЕНИЕ УСЛУГАМИ, МАСТЕРАМИ И РАСПИСАНИЕМ (РАЗДЕЛ 5)
// ============================================================================

async function handleAdminSaveService(request, env) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный JSON.', 400);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);

  const id =
    String(body.id || '').trim() ||
    `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const categoryId = String(body.categoryId || 'manicure').trim();
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const durationMinutes = Number(body.durationMinutes || 60);
  const priceRub = Number(body.priceRub || 0);
  const isActive = body.isActive === undefined ? 1 : body.isActive ? 1 : 0;
  const sortOrder = Number(body.sortOrder || 50);

  if (title.length < 2) {
    return errorResponse('INVALID_TITLE', 'Укажите название услуги.', 400);
  }
  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > 360 ||
    durationMinutes % 5 !== 0
  ) {
    return errorResponse(
      'INVALID_DURATION',
      'Длительность услуги должна быть от 15 до 360 минут и кратна 5 минутам.',
      400
    );
  }
  if (!Number.isFinite(priceRub) || priceRub <= 0) {
    return errorResponse('INVALID_PRICE', 'Стоимость услуги должна быть больше 0 ₽.', 400);
  }

  await db
    .prepare(
      `INSERT INTO services (id, category_id, title, description, duration_minutes, price_rub, is_active, is_demo, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         category_id = excluded.category_id,
         title = excluded.title,
         description = excluded.description,
         duration_minutes = excluded.duration_minutes,
         price_rub = excluded.price_rub,
         is_active = excluded.is_active`
    )
    .bind(
      id,
      categoryId,
      title,
      description || 'Индивидуальный ритуал ухода в студии LÉA.',
      durationMinutes,
      priceRub,
      isActive,
      sortOrder
    )
    .run();

  if (Array.isArray(body.masterIds) && body.masterIds.length > 0) {
    for (const mId of body.masterIds) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO master_services (master_id, service_id) VALUES (?, ?)`
        )
        .bind(String(mId), id)
        .run();
    }
  }

  return jsonResponse({
    ok: true,
    service: {
      id,
      categoryId,
      title,
      description,
      durationMinutes,
      priceRub,
      isActive: Boolean(isActive),
    },
  });
}

async function handleAdminSaveMaster(request, env) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный JSON.', 400);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);

  const id =
    String(body.id || '').trim() ||
    `mst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const name = String(body.name || '').trim();
  const role = String(body.role || 'Топ-мастер студии').trim();
  const specialization = String(body.specialization || role).trim();
  const bio = String(body.bio || 'Специалист LÉA STUDIO.').trim();
  const experienceYears = Number(body.experienceYears || 5);
  const isActive = body.isActive === undefined ? 1 : body.isActive ? 1 : 0;

  if (name.length < 2) {
    return errorResponse('INVALID_NAME', 'Укажите имя мастера.', 400);
  }

  await db
    .prepare(
      `INSERT INTO masters (id, name, role, specialization, bio, experience_years, portrait_key, is_active, is_demo, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 'anna', ?, 0, 10)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         specialization = excluded.specialization,
         bio = excluded.bio,
         experience_years = excluded.experience_years,
         is_active = excluded.is_active`
    )
    .bind(id, name, role, specialization, bio, experienceYears, isActive)
    .run();

  if (Array.isArray(body.serviceIds)) {
    await db
      .prepare('DELETE FROM master_services WHERE master_id = ?')
      .bind(id)
      .run();
    for (const sId of body.serviceIds) {
      await db
        .prepare(
          'INSERT OR IGNORE INTO master_services (master_id, service_id) VALUES (?, ?)'
        )
        .bind(id, String(sId))
        .run();
    }
  }

  // Если у нового мастера ещё нет расписания, создаём стандартный график 10:00–21:00
  const existingSched = await db
    .prepare('SELECT COUNT(*) AS cnt FROM master_schedules WHERE master_id = ?')
    .bind(id)
    .first();
  if (!existingSched || Number(existingSched.cnt) === 0) {
    for (let d = 0; d <= 6; d++) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO master_schedules (master_id, day_of_week, is_working, start_minute, end_minute, break_start_minute, break_end_minute)
           VALUES (?, ?, 1, 600, 1260, 840, 900)`
        )
        .bind(id, d)
        .run();
    }
  }

  return jsonResponse({
    ok: true,
    master: { id, name, role, specialization, bio, experienceYears, isActive: Boolean(isActive) },
  });
}

async function handleAdminSaveMasterSchedule(request, env, masterId) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Некорректный JSON.', 400);
  }

  const db = env.DB;
  await ensureDatabaseReady(db);

  if (Array.isArray(body.schedules)) {
    for (const item of body.schedules) {
      const dayOfWeek = Number(item.dayOfWeek);
      if (dayOfWeek < 0 || dayOfWeek > 6) continue;
      const isWorking = item.isWorking ? 1 : 0;
      const startMin = parseHHMMToMinutes(item.startTime || '10:00') ?? 600;
      const endMin = parseHHMMToMinutes(item.endTime || '21:00') ?? 1260;
      const breakStartMin = item.breakStart
        ? parseHHMMToMinutes(item.breakStart)
        : null;
      const breakEndMin = item.breakEnd ? parseHHMMToMinutes(item.breakEnd) : null;

      await db
        .prepare(
          `INSERT INTO master_schedules (
             master_id, day_of_week, is_working, start_minute, end_minute, break_start_minute, break_end_minute
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(master_id, day_of_week) DO UPDATE SET
             is_working = excluded.is_working,
             start_minute = excluded.start_minute,
             end_minute = excluded.end_minute,
             break_start_minute = excluded.break_start_minute,
             break_end_minute = excluded.break_end_minute`
        )
        .bind(
          masterId,
          dayOfWeek,
          isWorking,
          startMin,
          endMin,
          breakStartMin,
          breakEndMin
        )
        .run();
    }
  }

  if (body.addException && body.addException.date) {
    const ex = body.addException;
    const exId = `exc_${masterId}_${ex.date}`;
    await db
      .prepare(
        `INSERT INTO master_exceptions (
           id, master_id, exception_date, is_day_off, custom_start_minute, custom_end_minute, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(master_id, exception_date) DO UPDATE SET
           is_day_off = excluded.is_day_off,
           custom_start_minute = excluded.custom_start_minute,
           custom_end_minute = excluded.custom_end_minute,
           reason = excluded.reason`
      )
      .bind(
        exId,
        masterId,
        String(ex.date),
        ex.isDayOff ? 1 : 0,
        ex.customStart ? parseHHMMToMinutes(ex.customStart) : null,
        ex.customEnd ? parseHHMMToMinutes(ex.customEnd) : null,
        String(ex.reason || 'Выходной / изменение графика')
      )
      .run();
  }

  if (body.removeExceptionDate) {
    await db
      .prepare(
        'DELETE FROM master_exceptions WHERE master_id = ? AND exception_date = ?'
      )
      .bind(masterId, String(body.removeExceptionDate))
      .run();
  }

  return jsonResponse({ ok: true, masterId });
}

async function handleAdminRetryNotifications(request, env) {
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.authorized) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }
  const summary = await processPendingNotifications(env);
  return jsonResponse({ ok: true, summary });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/api/health' && request.method === 'GET') {
        return jsonResponse({ ok: true, service: 'l-a-studio' });
      }

      if ((path === '/api/catalog' || path === '/api/services') && request.method === 'GET') {
        return await handleGetCatalog(env);
      }

      if (path === '/api/availability' && request.method === 'GET') {
        return await handleGetAvailability(request, env);
      }

      if (path === '/api/holds' && request.method === 'POST') {
        return await handleCreateHold(request, env);
      }

      if (path === '/api/holds' && request.method === 'DELETE') {
        return await handleReleaseHold(request, env);
      }

      if (path === '/api/bookings' && request.method === 'POST') {
        return await handleCreateBooking(request, env);
      }

      // Аутентификация администратора
      if (path === '/api/admin/login' && request.method === 'POST') {
        return await handleAdminLogin(request, env);
      }

      if (path === '/api/admin/logout' && request.method === 'POST') {
        return await handleAdminLogout(request, env);
      }

      if (path === '/api/admin/session' && request.method === 'GET') {
        return await handleAdminSession(request, env);
      }

      if (
        (path === '/api/admin/overview' || path === '/api/admin/bookings') &&
        request.method === 'GET'
      ) {
        return await handleAdminOverview(request, env);
      }

      if (path === '/api/admin/notifications/retry' && request.method === 'POST') {
        return await handleAdminRetryNotifications(request, env);
      }

      if (path === '/api/admin/services' && (request.method === 'POST' || request.method === 'PUT')) {
        return await handleAdminSaveService(request, env);
      }

      if (path === '/api/admin/masters' && (request.method === 'POST' || request.method === 'PUT')) {
        return await handleAdminSaveMaster(request, env);
      }

      const masterScheduleMatch = path.match(/^\/api\/admin\/masters\/([^/]+)\/schedule$/);
      if (
        masterScheduleMatch &&
        (request.method === 'PUT' || request.method === 'POST')
      ) {
        return await handleAdminSaveMasterSchedule(
          request,
          env,
          decodeURIComponent(masterScheduleMatch[1])
        );
      }

      const cancelMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === 'POST') {
        return await handleAdminCancelBooking(
          request,
          env,
          decodeURIComponent(cancelMatch[1])
        );
      }

      const confirmMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/confirm$/);
      if (confirmMatch && request.method === 'POST') {
        return await handleAdminConfirmBooking(
          request,
          env,
          decodeURIComponent(confirmMatch[1])
        );
      }

      const rescheduleMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/reschedule$/);
      if (rescheduleMatch && request.method === 'POST') {
        return await handleAdminRescheduleBooking(
          request,
          env,
          decodeURIComponent(rescheduleMatch[1])
        );
      }

      const statusMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/status$/);
      if (statusMatch && (request.method === 'POST' || request.method === 'PATCH')) {
        return await handleAdminStatusChange(
          request,
          env,
          decodeURIComponent(statusMatch[1])
        );
      }

      if (
        [
          '/api/catalog',
          '/api/availability',
          '/api/holds',
          '/api/bookings',
          '/api/admin/overview',
          '/api/admin/bookings',
          '/api/admin/login',
          '/api/admin/logout',
          '/api/admin/session',
          '/api/admin/notifications/retry',
          '/api/admin/services',
          '/api/admin/masters',
        ].includes(path)
      ) {
        return errorResponse(
          'METHOD_NOT_ALLOWED',
          `Метод ${request.method} не поддерживается для данного маршрута.`,
          405
        );
      }

      if (!path.startsWith('/api/') && env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return await env.ASSETS.fetch(request);
      }

      return errorResponse('NOT_FOUND', 'Маршрут API не найден.', 404);
    } catch (err) {
      const safeErr = sanitizeTelegramError(
        err && err.message ? err.message : String(err),
        env?.TELEGRAM_BOT_TOKEN
      );
      console.error('[LEA Worker Error]', safeErr);
      return errorResponse(
        'INTERNAL_ERROR',
        'Произошла внутренняя ошибка сервера. Пожалуйста, повторите попытку позже.',
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(processPendingNotifications(env));
    } else {
      await processPendingNotifications(env);
    }
  },
};
