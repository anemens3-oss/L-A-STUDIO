/**
 * LÉA STUDIO — Серверная часть (Cloudflare Workers + Cloudflare D1)
 * Реализована исключительно на стандартных Web API (Fetch, URL, Request, Response, Web Crypto, AbortController)
 * без единой сторонней runtime-библиотеки.
 *
 * Ключевые механизмы безопасности и надёжности:
 * 1. Атомарное резервирование интервалов через env.DB.batch() (транзакция SQLite/D1)
 *    + таблица 5-минутных слотов booked_slots с PRIMARY KEY (master_id, slot_date, slot_minute)
 *    + триггер БД trg_prevent_booking_overlap для защиты от любых пересечений по длительности.
 * 2. Полное недоверие к данным клиента: цена, длительность и доступность мастера
 *    всегда загружаются и проверяются на сервере из таблиц services и master_services.
 * 3. Защита от повторной отправки через уникальный idempotency_key.
 * 4. Отправка уведомлений администратору через официальный Telegram Bot API
 *    (POST https://api.telegram.org/bot<TOKEN>/sendMessage) с проверкой HTTP-статуса и поля ok === true,
 *    защитой от утечки секретов, тайм-аутом и ограниченной очередью повторных попыток.
 */

const SLOT_UNIT_MINUTES = 5;
const DEFAULT_TIMEZONE_OFFSET_MINUTES = 180; // Europe/Moscow (UTC+3)
const DEFAULT_MIN_LEAD_MINUTES = 30;
const DEFAULT_HOLD_TTL_SECONDS = 300; // 5 минут на заполнение контактов
const DEFAULT_HORIZON_DAYS = 45;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 8000;
const DEFAULT_MAX_NOTIFICATION_ATTEMPTS = 5;

// По умолчанию хеш SHA-256 от демонстрационного пароля администратора "LeaAdmin2026!"
// В production переопределяется через серверный секрет ADMIN_PASSWORD_SHA256 в Cloudflare Workers
const DEFAULT_ADMIN_PASSWORD_SHA256 =
  '8472df4d8e26ebc36edd315e099b770e025261ec6575b2b90c31a9800d7001c7';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// Лёгкий серверный ограничитель частоты запросов по IP для защиты публичных POST-маршрутов
const rateLimitBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 35;

function checkRateLimit(request) {
  const clientIp =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '';
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

function errorResponse(code, message, status = 400, details = undefined) {
  const payload = { ok: false, error: { code, message } };
  if (details !== undefined) {
    payload.error.details = details;
  }
  return jsonResponse(payload, status);
}

/**
 * Вычисляет текущую дату (YYYY-MM-DD) и минуту суток в часовом поясе салона.
 * Позволяет передавать фиксированное время через env.__TEST_NOW_ISO для детерминированных автотестов.
 */
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
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) {
    return null;
  }
  const [hStr, mStr] = timeStr.split(':');
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
    return `+7 (${body.slice(0, 3)}) ${body.slice(3, 6)}-${body.slice(6, 8)}-${body.slice(8, 10)}`;
  }
  if (digits.length === 10) {
    return `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 10)}`;
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
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

async function isAdminAuthorized(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return false;
  }
  const passwordOrToken = authHeader.slice('Bearer '.length).trim();
  if (!passwordOrToken) return false;

  const expectedHash = (
    env.ADMIN_PASSWORD_SHA256 || DEFAULT_ADMIN_PASSWORD_SHA256
  ).toLowerCase();
  const actualHash = await sha256Hex(passwordOrToken);
  return timingSafeEqualHex(actualHash, expectedHash);
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

/**
 * Вычисляет эффективный рабочий график мастера на конкретную дату (с учётом исключений).
 */
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

/**
 * Проверяет, свободен ли интервал [startMinute, endMinute) у конкретного мастера на дату dateStr.
 */
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

/**
 * Удаляет любые возможные вхождения секретного токена из диагностических сообщений,
 * чтобы токен никогда не попадал в БД, логи или ответы API.
 */
function sanitizeTelegramError(rawMsg, botToken) {
  let msg = String(rawMsg || 'Unknown Telegram error');
  if (botToken && botToken.length > 3) {
    msg = msg.split(botToken).join('[REDACTED]');
  }
  msg = msg.replace(/bot[0-9]+:[A-Za-z0-9_-]+/gi, 'bot[REDACTED]');
  return msg.slice(0, 240);
}

/**
 * Формирует текст уведомления администратору в Telegram строго по формату п. 8.4 ТЗ.
 * Отправляется как обычный текст (без parse_mode), чтобы спецсимволы в комментарии клиента
 * никогда не вызывали ошибок парсинга Markdown/HTML на стороне Telegram API.
 */
export function formatTelegramBookingMessage(bookingRecord, serviceTitle, masterName) {
  const commentText =
    bookingRecord.client_comment && String(bookingRecord.client_comment).trim()
      ? String(bookingRecord.client_comment).trim()
      : 'нет';
  const priceFormatted = Number(bookingRecord.price_rub).toLocaleString('ru-RU');

  return [
    '🔔 Новая запись — LÉA STUDIO',
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
  ].join('\n');
}

/**
 * Записывает результат попытки отправки уведомления одновременно в:
 * - bookings (notification_status, telegram_status, telegram_attempts, telegram_last_error)
 * - notification_queue (status, attempts, next_retry_at, last_http_status, last_error_code, updated_at, sent_at)
 * - notification_logs (история попыток для диагностики)
 */
async function recordTelegramAttemptState(db, {
  bookingId,
  status,
  attemptNumber,
  nextRetryUnix = null,
  httpStatus = null,
  errorCode = '',
  errorMessage = '',
  nowIso,
  sentAtIso = null,
}) {
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

/**
 * Отправка уведомления администратору через официальный Telegram Bot API:
 * POST https://api.telegram.org/bot<TOKEN>/sendMessage
 *
 * Гарантирует:
 * - проверку наличия TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID;
 * - проверку HTTP-статуса И поля JSON-ответа data.ok === true;
 * - защиту от зависаний через AbortController (тайм-аут);
 * - отсутствие утечки секретов в ошибках и логах;
 * - сохранение подтверждённой записи при любом сбое Telegram.
 */
async function sendTelegramNotificationForBooking(
  env,
  bookingRecord,
  serviceTitle,
  masterName,
  currentAttempts = 0,
  maxAttempts = DEFAULT_MAX_NOTIFICATION_ATTEMPTS
) {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const botToken = env.TELEGRAM_BOT_TOKEN ? String(env.TELEGRAM_BOT_TOKEN).trim() : '';
  const chatId = env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID).trim() : '';
  const apiBaseUrl = (env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '');
  const timeoutMs = Number(env.TELEGRAM_TIMEOUT_MS || DEFAULT_TELEGRAM_TIMEOUT_MS);

  // 1. Проверка наличия секретов TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID
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

    return {
      sent: false,
      status: 'awaiting_configuration',
      code: missingCode,
    };
  }

  const attemptNumber = currentAttempts + 1;
  const messageText = formatTelegramBookingMessage(bookingRecord, serviceTitle, masterName);
  const endpointUrl = `${apiBaseUrl}/bot${botToken}/sendMessage`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(new Error('TELEGRAM_TIMEOUT')), timeoutMs);

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
      // Ответ невозможно разобрать как JSON
      const reachedLimit = attemptNumber >= maxAttempts;
      const nextStatus = reachedLimit ? 'failed_permanent' : 'failed_retry_scheduled';
      const errorCode = reachedLimit
        ? 'TELEGRAM_MAX_ATTEMPTS_EXCEEDED'
        : 'TELEGRAM_INVALID_JSON';
      const nextRetryUnix = reachedLimit
        ? null
        : Math.floor(Date.now() / 1000) + 120 * Math.pow(2, currentAttempts);

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

      return {
        sent: false,
        status: nextStatus,
        httpStatus: statusCode,
        code: errorCode,
      };
    }

    // Успешной отправкой считается ТОЛЬКО HTTP 2xx И наличие поля ok === true в ответе Telegram Bot API
    if (response.ok && parsedBody && parsedBody.ok === true) {
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

      return { sent: true, status: 'sent', httpStatus: statusCode };
    }

    // Обработка случая, когда Telegram вернул ok: false или HTTP-ошибку
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

    return {
      sent: false,
      status: nextStatus,
      code: errorCode,
    };
  }
}

/**
 * Повторная отправка отложенных уведомлений Telegram (вызывается по Cron или из админ-панели).
 * - Не создаёт дубликатов записей;
 * - Игнорирует демонстрационные записи (is_demo = 1);
 * - Останавливает повторные попытки при достижении max_attempts (переводит в failed_permanent).
 */
async function processPendingNotifications(env) {
  const db = env.DB;
  const nowUnix = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();

  // Если в очереди есть записи, достигшие лимита попыток, фиксируем их как failed_permanent
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
              s.title AS service_title, m.name AS master_name
       FROM notification_queue n
       JOIN bookings b ON b.id = n.booking_id
       JOIN services s ON s.id = b.service_id
       JOIN masters m ON m.id = b.master_id
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
      Number(row.max_attempts || DEFAULT_MAX_NOTIFICATION_ATTEMPTS)
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
// ОБРАБОТЧИКИ МАРШРУТОВ API
// ============================================================================

async function handleGetCatalog(env) {
  const db = env.DB;
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
  const serviceId = (url.searchParams.get('serviceId') || '').trim();
  const masterId = (url.searchParams.get('masterId') || '').trim();
  const dateStr = (url.searchParams.get('date') || '').trim();
  const holdToken = (url.searchParams.get('holdToken') || '').trim();

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

  // Загружаем услугу строго с сервера
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

  // Определяем список проверяемых мастеров
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

  // Для каждого кандидата загружаем график на выбранный день, занятые слоты и временные удержания
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

    const [bookedRes, holdsRes] = await Promise.all([
      db
        .prepare(
          'SELECT slot_minute FROM booked_slots WHERE master_id = ? AND slot_date = ?'
        )
        .bind(m.id, dateStr)
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

/**
 * Временное удержание слота (Slot Hold) на время ввода имени и телефона клиентом (5 минут).
 */
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

  // Освобождаем предыдущее удержание этого же клиента
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
      // Переходим к следующему кандидату, если слот был перехвачен параллельным запросом
    }
  }

  return errorResponse(
    'SLOT_ALREADY_TAKEN',
    'К сожалению, выбранный интервал только что заняли. Пожалуйста, выберите другое время.',
    409
  );
}

async function handleReleaseHold(request, env) {
  const url = new URL(request.url);
  const holdToken = (url.searchParams.get('holdToken') || '').trim();
  if (holdToken) {
    await env.DB.prepare('DELETE FROM slot_holds WHERE hold_token = ?')
      .bind(holdToken)
      .run();
  }
  return jsonResponse({ ok: true });
}

/**
 * Создание бронирования с атомарным захватом всех 5-минутных слотов и проверкой идемпотентности.
 */
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

  const headerIdempotencyKey = request.headers.get('X-Idempotency-Key') || '';
  const idempotencyKey = String(
    body.idempotencyKey || headerIdempotencyKey || ''
  ).trim();
  const serviceId = String(body.serviceId || '').trim();
  const requestedMasterId = String(body.masterId || '').trim();
  const dateStr = String(body.date || '').trim();
  const timeStr = String(body.time || '').trim();
  const firstName = String(body.clientName || '').trim();
  const lastName = String(body.clientLastName || '').trim();
  const clientName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
  const rawPhone = String(body.clientPhone || '').trim();
  const clientComment = String(body.clientComment || '').trim().slice(0, 500);
  const holdToken = String(body.holdToken || '').trim();
  const consentAccepted = Boolean(body.consentAccepted);

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

  // 1. Проверка идемпотентности (повторная отправка того же запроса)
  const existingByKey = await db
    .prepare(
      `SELECT b.id, b.service_id, b.master_id, b.booking_date, b.start_time, b.end_time,
              b.duration_minutes, b.price_rub, b.client_name, b.client_phone, b.client_comment,
              b.status, b.notification_status, b.telegram_status, b.telegram_attempts, b.telegram_last_error, b.created_at,
              s.title AS service_title, m.name AS master_name
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       JOIN masters m ON m.id = b.master_id
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

  // 2. Авторитетная загрузка услуги с сервера (игнорируем любые цены/длительность от клиента)
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

    // Проверяем, нет ли активного чужого удержания (slot_holds)
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

    const bookingId = generateBookingCode(dateStr);
    const notifId = `NTF-${bookingId}`;
    const createdAtIso = salonNow.nowIsoUtc;

    // Формируем единый атомарный пакет транзакции D1 (env.DB.batch)
    const batchStatements = [];

    if (holdToken) {
      batchStatements.push(
        db
          .prepare('DELETE FROM slot_holds WHERE hold_token = ?')
          .bind(holdToken)
      );
    }

    batchStatements.push(
      db
        .prepare(
          `INSERT INTO bookings (
            id, idempotency_key, service_id, master_id, booking_date,
            start_time, end_time, start_minute, end_minute,
            duration_minutes, price_rub, client_name, client_phone, client_comment,
            status, notification_status, telegram_status, telegram_attempts, telegram_last_error, is_demo, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', 'pending', 0, '', 0, ?)`
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
          normalizedPhone,
          clientComment,
          createdAtIso
        )
    );

    // Атомарный захват каждого 5-минутного слота на интервале [startMinute, endMinute)
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
        client_phone: normalizedPhone,
        client_comment: clientComment,
        status: 'confirmed',
        notification_status: 'pending',
        telegram_status: 'pending',
        telegram_attempts: 0,
        telegram_last_error: '',
        created_at: createdAtIso,
      };

      // 5. Отправка уведомления в Telegram после успешной фиксации транзакции
      const notifOutcome = await sendTelegramNotificationForBooking(
        env,
        bookingRecord,
        service.title,
        candidate.name,
        0,
        DEFAULT_MAX_NOTIFICATION_ATTEMPTS
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

      // Если параллельный запрос с тем же самым idempotency_key успел первым
      if (errMsg.includes('bookings.idempotency_key')) {
        const winner = await db
          .prepare(
            `SELECT b.id, b.service_id, b.master_id, b.booking_date, b.start_time, b.end_time,
                    b.duration_minutes, b.price_rub, b.client_name, b.client_phone, b.client_comment,
                    b.status, b.notification_status, b.telegram_status, b.telegram_attempts, b.telegram_last_error, b.created_at,
                    s.title AS service_title, m.name AS master_name
             FROM bookings b
             JOIN services s ON s.id = b.service_id
             JOIN masters m ON m.id = b.master_id
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
      // Если был выбран "any", цикл попробует следующего свободного мастера
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
    'Этот временной интервал уже занят или пересекается с другой записью. Пожалуйста, выберите другое свободное время.',
    409
  );
}

function formatBookingResponse(row) {
  const notifStatus = row.telegram_status || row.notification_status || 'pending';
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceTitle: row.service_title,
    masterId: row.master_id,
    masterName: row.master_name,
    date: row.booking_date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: Number(row.duration_minutes),
    priceRub: Number(row.price_rub),
    clientName: row.client_name,
    clientPhone: row.client_phone,
    clientComment: row.client_comment || '',
    status: row.status,
    notificationStatus: notifStatus,
    telegramStatus: notifStatus,
    telegramAttempts: Number(row.telegram_attempts || 0),
    createdAt: row.created_at,
  };
}

// ============================================================================
// ЗАЩИЩЁННЫЕ АДМИНИСТРАТИВНЫЕ МАРШРУТЫ
// ============================================================================

async function handleAdminOverview(request, env) {
  if (!(await isAdminAuthorized(request, env))) {
    return errorResponse(
      'UNAUTHORIZED',
      'Требуется серверная авторизация администратора.',
      401
    );
  }

  const db = env.DB;
  const [bookingsRes, queueRes, logsRes] = await Promise.all([
    db
      .prepare(
        `SELECT b.id, b.service_id, b.master_id, b.booking_date, b.start_time, b.end_time,
                b.duration_minutes, b.price_rub, b.client_name, b.client_phone, b.client_comment,
                b.status, b.notification_status, b.telegram_status, b.telegram_attempts, b.telegram_last_error,
                b.created_at, b.cancelled_at,
                s.title AS service_title, m.name AS master_name
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN masters m ON m.id = b.master_id
         ORDER BY b.booking_date DESC, b.start_minute ASC
         LIMIT 100`
      )
      .all(),
    db
      .prepare(
        `SELECT id, booking_id, channel, status, attempts, max_attempts,
                next_retry_at, last_http_status, last_error_code, updated_at, sent_at
         FROM notification_queue
         ORDER BY updated_at DESC
         LIMIT 50`
      )
      .all(),
    db
      .prepare(
        `SELECT id, booking_id, channel, status, attempt, http_status, error_code, error_message, created_at
         FROM notification_logs
         ORDER BY id DESC
         LIMIT 50`
      )
      .all(),
  ]);

  const botTokenConfigured = Boolean(
    env.TELEGRAM_BOT_TOKEN && String(env.TELEGRAM_BOT_TOKEN).trim()
  );
  const chatIdConfigured = Boolean(
    env.TELEGRAM_CHAT_ID && String(env.TELEGRAM_CHAT_ID).trim()
  );

  return jsonResponse({
    ok: true,
    telegramIntegration: {
      configured: botTokenConfigured && chatIdConfigured,
      botTokenConfigured,
      chatIdConfigured,
      apiEndpoint: 'https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage',
    },
    bookings: (bookingsRes.results || []).map((row) => ({
      ...formatBookingResponse(row),
      telegramLastError: row.telegram_last_error || '',
    })),
    notificationQueue: queueRes.results || [],
    notificationLogs: logsRes.results || [],
  });
}

async function handleAdminCancelBooking(request, env, bookingId) {
  if (!(await isAdminAuthorized(request, env))) {
    return errorResponse('UNAUTHORIZED', 'Требуется авторизация администратора.', 401);
  }

  const db = env.DB;
  const existing = await db
    .prepare('SELECT id, status FROM bookings WHERE id = ?')
    .bind(bookingId)
    .first();

  if (!existing) {
    return errorResponse('BOOKING_NOT_FOUND', 'Запись не найдена.', 404);
  }

  if (existing.status === 'cancelled') {
    return jsonResponse({ ok: true, id: bookingId, status: 'cancelled' });
  }

  const nowIso = new Date().toISOString();
  // Триггер trg_release_slots_on_cancel + явный DELETE в транзакции гарантируют освобождение всех слотов
  await db.batch([
    db
      .prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`
      )
      .bind(nowIso, bookingId),
    db.prepare('DELETE FROM booked_slots WHERE booking_id = ?').bind(bookingId),
  ]);

  return jsonResponse({
    ok: true,
    id: bookingId,
    status: 'cancelled',
    cancelledAt: nowIso,
  });
}

async function handleAdminRetryNotifications(request, env) {
  if (!(await isAdminAuthorized(request, env))) {
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
        return jsonResponse({ ok: true, service: 'lea-studio-worker' });
      }

      if (path === '/api/catalog' && request.method === 'GET') {
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

      if (path === '/api/admin/overview' && request.method === 'GET') {
        return await handleAdminOverview(request, env);
      }

      if (path === '/api/admin/notifications/retry' && request.method === 'POST') {
        return await handleAdminRetryNotifications(request, env);
      }

      const cancelMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === 'POST') {
        return await handleAdminCancelBooking(
          request,
          env,
          decodeURIComponent(cancelMatch[1])
        );
      }

      if (
        ['/api/catalog', '/api/availability', '/api/holds', '/api/bookings', '/api/admin/overview', '/api/admin/notifications/retry'].includes(path)
      ) {
        return errorResponse(
          'METHOD_NOT_ALLOWED',
          `Метод ${request.method} не поддерживается для данного маршрута.`,
          405
        );
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
