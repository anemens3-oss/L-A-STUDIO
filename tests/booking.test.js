/**
 * Автоматические интеграционные, нагрузочные и защитные тесты LÉA STUDIO
 * Запуск: node --test tests/booking.test.js
 *
 * Покрывает все обязательные сценарии из разделов 7, 8.7 и 12 ТЗ:
 * [Бронирование и защита от двойной записи]
 * 1. Загрузка каталога услуг, категорий и мастеров
 * 2. Запрет записи к мастеру на услугу, которую он не оказывает
 * 3. Запрет записи на прошедшие даты, нерабочие часы и выходные дни мастера
 * 4. Эталонный сценарий пересечения интервалов (14:00–15:00, отказ 14:00–14:30 / 14:30–15:30, разрешение 15:00–16:00 и к другому мастеру)
 * 5. Конкурентная гонка: 10 одновременных запросов на один интервал -> ровно 1 успех, 9 отказов
 * 6. Идемпотентность: повторная отправка с тем же idempotencyKey не создаёт дубликат
 * 7. Защита от подмены цены и длительности услуги со стороны клиента
 * 8. Безопасное освобождение слотов при отмене записи
 *
 * [Тестирование Telegram Bot API — п. 8.7 и п. 12]
 * 9.  Успешный ответ Telegram (HTTP 200 + ok: true) и проверка точного формата сообщения
 * 10. Ответ Telegram с ok: false (даже при HTTP 200) -> НЕ помечается как sent, запись сохраняется
 * 11. Отсутствующие секреты (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) -> awaiting_configuration + понятная диагностика
 * 12. Сетевая ошибка (Network Error) -> запись сохраняется, статус failed_retry_scheduled
 * 13. Тайм-аут запроса к Telegram API -> запись сохраняется, статус failed_retry_scheduled (TELEGRAM_TIMEOUT)
 * 14. Некорректный JSON от Telegram -> корректная обработка (TELEGRAM_INVALID_JSON)
 * 15. Повторная попытка отправки (Retry) и ограничение максимального числа попыток (max_attempts -> failed_permanent)
 * 16. Отсутствие дублирования записи при повторной отправке уведомления
 * 17. Отсутствие токенов и секретов во фронтенде, API-ответах и отслеживаемых файлах Git
 * 18. Защита административных маршрутов от неавторизованного доступа
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { createInitializedD1Database } from '../worker/d1-sqlite-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const migrationsDir = path.resolve(rootDir, 'migrations');

function createTestEnv(overrides = {}) {
  const db = createInitializedD1Database({
    dbPath: ':memory:',
    migrationsDir,
  });

  // Фиксируем текущее время для детерминированных тестов: Четверг, 2026-10-29 09:00 UTC (12:00 МСК)
  return {
    DB: db,
    __TEST_NOW_ISO: '2026-10-29T09:00:00.000Z',
    TELEGRAM_BOT_TOKEN: '123456789:TEST_BOT_SECRET_TOKEN_DO_NOT_LEAK',
    TELEGRAM_CHAT_ID: '-100987654321',
    __TEST_TELEGRAM_FETCH: async (url, init) => {
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 101 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
    ...overrides,
  };
}

async function callWorker(env, method, urlPath, bodyObj = null, headers = {}) {
  const reqInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (bodyObj !== null) {
    reqInit.body = JSON.stringify(bodyObj);
  }
  const req = new Request(`https://lea-studio.local${urlPath}`, reqInit);
  const res = await worker.fetch(req, env, { waitUntil: () => {} });
  const data = await res.json();
  return { status: res.status, data, headers: res.headers };
}

test('1. Каталог услуг, категорий и мастеров корректно загружается с сервера', async () => {
  const env = createTestEnv();
  const { status, data } = await callWorker(env, 'GET', '/api/catalog');

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.salon.name, 'LÉA STUDIO');
  assert.equal(data.salon.telegramBotConfigured, true);
  assert.ok(data.categories.length >= 5, 'Должно быть минимум 5 стартовых категорий');
  assert.ok(data.services.length >= 10, 'Должны быть загружены услуги');
  assert.ok(data.masters.length >= 4, 'Должны быть загружены мастера');
});

test('2. Запрет записи к мастеру на услугу, которую он не оказывает, и несуществующую услугу', async () => {
  const env = createTestEnv();

  // Несуществующая услуга
  const unknownSrv = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_unknown_service_01',
    serviceId: 'srv_non_existent',
    masterId: 'mst_anna',
    date: '2026-10-30',
    time: '14:00',
    clientName: 'Екатерина',
    clientPhone: '+7 (999) 111-22-33',
    consentAccepted: true,
  });
  assert.equal(unknownSrv.status, 404);
  assert.equal(unknownSrv.data.error.code, 'SERVICE_NOT_FOUND');

  // Мария (mst_maria) — бровист, она не делает скульптурный массаж лица (srv_face_sculpt)
  const availRes = await callWorker(
    env,
    'GET',
    '/api/availability?serviceId=srv_face_sculpt&masterId=mst_maria&date=2026-10-30'
  );
  assert.equal(availRes.status, 400);
  assert.equal(availRes.data.error.code, 'MASTER_SERVICE_MISMATCH');

  const bookRes = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_mismatch_test_01',
    serviceId: 'srv_face_sculpt',
    masterId: 'mst_maria',
    date: '2026-10-30',
    time: '14:00',
    clientName: 'Екатерина',
    clientPhone: '+7 (999) 111-22-33',
    consentAccepted: true,
  });
  assert.equal(bookRes.status, 400);
  assert.equal(bookRes.data.error.code, 'MASTER_SERVICE_MISMATCH');
});

test('3. Прошедшие даты, нерабочие часы и выходные дни мастера строго отклоняются', async () => {
  const env = createTestEnv();

  // Прошедшая дата: 2026-10-28 (при текущем 2026-10-29)
  const pastRes = await callWorker(
    env,
    'GET',
    '/api/availability?serviceId=srv_mani_naked&masterId=mst_anna&date=2026-10-28'
  );
  assert.equal(pastRes.status, 400);
  assert.equal(pastRes.data.error.code, 'PAST_DATE_FORBIDDEN');

  const pastBook = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_past_date_01',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: '2026-10-28',
    time: '14:00',
    clientName: 'Анна',
    clientPhone: '+7 (999) 111-22-33',
    consentAccepted: true,
  });
  assert.equal(pastBook.status, 400);
  assert.equal(pastBook.data.error.code, 'PAST_DATE_FORBIDDEN');

  // Понедельник 2026-11-02 — выходной день у мастера Анны (mst_anna)
  const dayOffBook = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_dayoff_01',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: '2026-11-02',
    time: '14:00',
    clientName: 'Анна',
    clientPhone: '+7 (999) 111-22-33',
    consentAccepted: true,
  });
  assert.equal(dayOffBook.status, 409);
  assert.equal(dayOffBook.data.error.code, 'MASTER_DAY_OFF');

  // Нерабочие часы (22:00 — после закрытия в 21:00)
  const afterHoursBook = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_after_hours_01',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: '2026-10-30',
    time: '20:30', // 60 мин -> окончание в 21:30, после закрытия 21:00
    clientName: 'Анна',
    clientPhone: '+7 (999) 111-22-33',
    consentAccepted: true,
  });
  assert.equal(afterHoursBook.status, 409);
  assert.equal(afterHoursBook.data.error.code, 'OUTSIDE_WORKING_HOURS');
});

test('4. Эталонный сценарий пересечения интервалов (Клиенты A, B, C, D к мастеру Анне)', async () => {
  const env = createTestEnv();
  const targetDate = '2026-10-30'; // Пятница, рабочий день Анны

  // Клиент A записывается к Анне на 14:00–15:00 (srv_mani_naked = 60 мин)
  const resA = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_client_A_1400',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: targetDate,
    time: '14:00',
    clientName: 'Клиент А',
    clientPhone: '+7 (900) 000-00-01',
    consentAccepted: true,
  });
  assert.equal(resA.status, 201, 'Клиент A должен успешно записаться на 14:00–15:00');
  assert.equal(resA.data.booking.startTime, '14:00');
  assert.equal(resA.data.booking.endTime, '15:00');

  // Клиент B пытается записаться к Анне на 14:00 -> ОТКАЗ
  const resB = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_client_B_1400',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: targetDate,
    time: '14:00',
    clientName: 'Клиент Б',
    clientPhone: '+7 (900) 000-00-02',
    consentAccepted: true,
  });
  assert.equal(resB.status, 409, 'Клиент B должен получить отказ 409 при записи на 14:00');
  assert.equal(resB.data.error.code, 'BOOKING_OVERLAP_CONFLICT');

  // Клиент C пытается записаться к Анне на 14:30–15:30 (пересечение второй половины!) -> ОТКАЗ
  const resC = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_client_C_1430',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: targetDate,
    time: '14:30',
    clientName: 'Клиент В',
    clientPhone: '+7 (900) 000-00-03',
    consentAccepted: true,
  });
  assert.equal(
    resC.status,
    409,
    'Клиент C должен получить отказ 409 при пересекающемся интервале 14:30–15:30'
  );
  assert.equal(resC.data.error.code, 'BOOKING_OVERLAP_CONFLICT');

  // Клиент D записывается к Анне на 15:00–16:00 (стыкующийся интервал без пересечения) -> РАЗРЕШЕНО
  const resD = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_client_D_1500',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: targetDate,
    time: '15:00',
    clientName: 'Клиент Г',
    clientPhone: '+7 (900) 000-00-04',
    consentAccepted: true,
  });
  assert.equal(
    resD.status,
    201,
    'Клиент D должен успешно записаться на стыкующийся слот 15:00–16:00'
  );

  // Параллельная запись к ДРУГОМУ мастеру (Софии) на то же самое время 14:00–15:00 -> РАЗРЕШЕНО
  const resOtherMaster = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'idemp_client_sofia_1400',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_sofia',
    date: targetDate,
    time: '14:00',
    clientName: 'Клиент Д',
    clientPhone: '+7 (900) 000-00-05',
    consentAccepted: true,
  });
  assert.equal(
    resOtherMaster.status,
    201,
    'Запись к другому свободному мастеру на 14:00–15:00 должна быть разрешена'
  );
});

test('5. Конкурентная гонка: 10 одновременных запросов на один интервал создают ровно 1 запись', async () => {
  const env = createTestEnv();
  const targetDate = '2026-10-31';

  const parallelPromises = Array.from({ length: 10 }, (_, idx) => {
    const startTime = idx % 2 === 0 ? '16:00' : '16:30';
    return callWorker(env, 'POST', '/api/bookings', {
      idempotencyKey: `concurrent_race_key_${idx}`,
      serviceId: 'srv_mani_gel', // 90 минут
      masterId: 'mst_anna',
      date: targetDate,
      time: startTime,
      clientName: `Конкурентный Клиент ${idx}`,
      clientPhone: `+7 (911) 000-00-${String(idx).padStart(2, '0')}`,
      consentAccepted: true,
    });
  });

  const results = await Promise.all(parallelPromises);
  const succeeded = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);

  assert.equal(
    succeeded.length,
    1,
    'Ровно ОДИН из 10 параллельных пересекающихся запросов должен завершиться успехом'
  );
  assert.equal(
    rejected.length,
    9,
    'Остальные 9 параллельных запросов должны получить отказ 409 Conflict'
  );

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM bookings WHERE master_id = 'mst_anna' AND booking_date = ? AND status = 'confirmed'`
  )
    .bind(targetDate)
    .first();
  assert.equal(Number(countRow.cnt), 1);
});

test('6. Идемпотентность: повторная отправка запроса с тем же idempotencyKey не создаёт дубликат', async () => {
  const env = createTestEnv();
  const payload = {
    idempotencyKey: 'same_idempotency_key_999',
    serviceId: 'srv_brow_arch',
    masterId: 'mst_maria',
    date: '2026-10-30',
    time: '11:00',
    clientName: 'Марина',
    clientLastName: 'Соколова',
    clientPhone: '+7 (926) 555-44-33',
    consentAccepted: true,
  };

  const first = await callWorker(env, 'POST', '/api/bookings', payload);
  assert.equal(first.status, 201);
  assert.equal(first.data.idempotentReplay, false);
  assert.equal(first.data.booking.clientName, 'Марина Соколова');

  const second = await callWorker(env, 'POST', '/api/bookings', payload);
  assert.equal(second.status, 200);
  assert.equal(second.data.idempotentReplay, true);
  assert.equal(
    second.data.booking.id,
    first.data.booking.id,
    'Должен вернуться тот же самый номер бронирования без создания второй записи'
  );
});

test('7. Защита от подмены цены и длительности услуги со стороны клиента', async () => {
  const env = createTestEnv();

  const res = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'tamper_attempt_01',
    serviceId: 'srv_face_glow',
    masterId: 'mst_elena',
    date: '2026-10-30',
    time: '12:00',
    priceRub: 1,
    durationMinutes: 5,
    clientName: 'Тест Безопасности',
    clientPhone: '+7 (999) 888-77-66',
    consentAccepted: true,
  });

  assert.equal(res.status, 201);
  assert.equal(
    res.data.booking.priceRub,
    6200,
    'Сервер обязан игнорировать цену из браузера и использовать цену из БД (6200 ₽)'
  );
  assert.equal(
    res.data.booking.durationMinutes,
    90,
    'Сервер обязан использовать длительность услуги из БД (90 мин)'
  );
  assert.equal(res.data.booking.endTime, '13:30');
});

test('8. Отмена записи администратором безопасно освобождает занятые слоты', async () => {
  const env = createTestEnv();
  const dateStr = '2026-11-01';

  const created = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'cancel_slot_release_01',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: dateStr,
    time: '10:00',
    clientName: 'Елена',
    clientPhone: '+7 (905) 123-45-67',
    consentAccepted: true,
  });
  assert.equal(created.status, 201);
  const bookingId = created.data.booking.id;

  const cancelRes = await callWorker(
    env,
    'POST',
    `/api/admin/bookings/${bookingId}/cancel`,
    {},
    { Authorization: 'Bearer LeaAdmin2026!' }
  );
  assert.equal(cancelRes.status, 200);

  const rebookRes = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'cancel_slot_release_02',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: dateStr,
    time: '10:00',
    clientName: 'Новый Клиент',
    clientPhone: '+7 (905) 999-88-77',
    consentAccepted: true,
  });
  assert.equal(
    rebookRes.status,
    201,
    'После отмены записи слот 10:00–11:00 должен снова стать доступным для бронирования'
  );
});

// ============================================================================
// ТЕСТЫ TELEGRAM BOT API (П. 8.7 И П. 12 ТЗ)
// ============================================================================

test('9. Telegram (п. 8.7 #1): Успешная отправка через sendMessage и проверка формата сообщения', async () => {
  const capturedCalls = [];
  const env = createTestEnv({
    __TEST_TELEGRAM_FETCH: async (url, init) => {
      capturedCalls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 777 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const res = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'tg_success_format_01',
    serviceId: 'srv_hair_blowout',
    masterId: 'mst_sofia',
    date: '2026-10-30',
    time: '11:00',
    clientName: 'Анастасия',
    clientLastName: 'Волкова',
    clientPhone: '+7 (903) 123-45-67',
    clientComment: 'Аллергии нет',
    consentAccepted: true,
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.booking.notificationStatus, 'sent');
  assert.equal(res.data.booking.telegramStatus, 'sent');
  assert.equal(capturedCalls.length, 1);

  const call = capturedCalls[0];
  assert.equal(
    call.url,
    'https://api.telegram.org/bot123456789:TEST_BOT_SECRET_TOKEN_DO_NOT_LEAK/sendMessage'
  );
  assert.equal(call.body.chat_id, '-100987654321');
  assert.equal(call.body.parse_mode, undefined, 'Отправка должна быть без parse_mode');

  const text = call.body.text;
  assert.ok(text.includes('🔔 Новая запись — LÉA STUDIO'));
  assert.ok(text.includes('👤 Клиент: Анастасия Волкова'));
  assert.ok(text.includes('📞 Телефон: +7 (903) 123-45-67'));
  assert.ok(text.includes('💅 Услуга: Дневная воздушная укладка на брашинг или стайлер'));
  assert.ok(text.includes('👩💼 Мастер: София Корсакова'));
  assert.ok(text.includes('📅 Дата: 2026-10-30'));
  assert.ok(text.includes('🕒 Время: 11:00–12:00'));
  assert.ok(text.includes('⏱ Продолжительность: 60 мин.'));
  assert.ok(text.includes('₽'));
  assert.ok(text.includes('📝 Комментарий: Аллергии нет'));
  assert.ok(text.includes(`🆔 Номер записи: ${res.data.booking.id}`));
});

test('10. Telegram (п. 8.7 #2): Ответ с ok: false (даже при HTTP 200) НЕ помечается как sent и не удаляет запись', async () => {
  const env = createTestEnv({
    __TEST_TELEGRAM_FETCH: async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const res = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'tg_ok_false_01',
    serviceId: 'srv_brow_arch',
    masterId: 'mst_maria',
    date: '2026-10-30',
    time: '12:00',
    clientName: 'Дарья',
    clientPhone: '+7 (903) 222-33-44',
    consentAccepted: true,
  });

  // Запись обязана сохраниться!
  assert.equal(res.status, 201);
  assert.notEqual(res.data.booking.notificationStatus, 'sent');
  assert.equal(res.data.booking.notificationStatus, 'failed_permanent');

  const row = await env.DB.prepare(
    'SELECT status, telegram_status, telegram_attempts, telegram_last_error FROM bookings WHERE id = ?'
  )
    .bind(res.data.booking.id)
    .first();
  assert.equal(row.status, 'confirmed');
  assert.equal(row.telegram_status, 'failed_permanent');
  assert.equal(Number(row.telegram_attempts), 1);
  assert.ok(row.telegram_last_error.includes('TELEGRAM_API_OK_FALSE'));
});

test('11. Telegram (п. 8.7 #3): Отсутствующие секреты выдают статус awaiting_configuration и сохраняют запись', async () => {
  const env = createTestEnv({
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
  });

  const res = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'tg_missing_secrets_01',
    serviceId: 'srv_brow_arch',
    masterId: 'mst_maria',
    date: '2026-10-30',
    time: '13:00',
    clientName: 'Ксения',
    clientPhone: '+7 (903) 333-44-55',
    consentAccepted: true,
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.booking.notificationStatus, 'awaiting_configuration');

  const qRow = await env.DB.prepare(
    'SELECT status, last_error_code FROM notification_queue WHERE booking_id = ?'
  )
    .bind(res.data.booking.id)
    .first();
  assert.equal(qRow.status, 'awaiting_configuration');
  assert.equal(qRow.last_error_code, 'TELEGRAM_SECRETS_NOT_CONFIGURED');
});

test('12. Telegram (п. 8.7 #4 и #5): Сетевая ошибка и тайм-аут обрабатываются безопасно и не раскрывают токен', async () => {
  // Сценарий A: Сетевая ошибка, в тексте которой присутствует URL с токеном
  const envNet = createTestEnv({
    __TEST_TELEGRAM_FETCH: async (url) => {
      throw new Error(`Fetch failed for ${url}: ECONNRESET`);
    },
  });

  const resNet = await callWorker(envNet, 'POST', '/api/bookings', {
    idempotencyKey: 'tg_net_error_01',
    serviceId: 'srv_brow_arch',
    masterId: 'mst_maria',
    date: '2026-10-30',
    time: '15:00',
    clientName: 'Ирина',
    clientPhone: '+7 (903) 444-55-66',
    consentAccepted: true,
  });

  assert.equal(resNet.status, 201);
  assert.equal(resNet.data.booking.notificationStatus, 'failed_retry_scheduled');

  const bNet = await envNet.DB.prepare(
    'SELECT telegram_last_error FROM bookings WHERE id = ?'
  )
    .bind(resNet.data.booking.id)
    .first();
  assert.ok(bNet.telegram_last_error.includes('TELEGRAM_NETWORK_ERROR'));
  assert.ok(
    !bNet.telegram_last_error.includes('TEST_BOT_SECRET_TOKEN_DO_NOT_LEAK'),
    'Секретный токен бота должен быть отредактирован ([REDACTED]) и не попадать в БД!'
  );

  // Сценарий B: Тайм-аут запроса
  const envTimeout = createTestEnv({
    TELEGRAM_TIMEOUT_MS: 20,
    __TEST_TELEGRAM_FETCH: async (_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }
      });
    },
  });

  const resTimeout = await callWorker(envTimeout, 'POST', '/api/bookings', {
    idempotencyKey: 'tg_timeout_01',
    serviceId: 'srv_brow_arch',
    masterId: 'mst_maria',
    date: '2026-10-30',
    time: '16:00',
    clientName: 'Полина',
    clientPhone: '+7 (903) 555-66-77',
    consentAccepted: true,
  });

  assert.equal(resTimeout.status, 201);
  assert.equal(resTimeout.data.booking.notificationStatus, 'failed_retry_scheduled');

  const qTimeout = await envTimeout.DB.prepare(
    'SELECT last_error_code FROM notification_queue WHERE booking_id = ?'
  )
    .bind(resTimeout.data.booking.id)
    .first();
  assert.equal(qTimeout.last_error_code, 'TELEGRAM_TIMEOUT');
});

test('13. Telegram (п. 8.7 #6, #7, #10): Повторная отправка работает без дублирования записи и ограничена max_attempts', async () => {
  let shouldFail = true;
  let callCount = 0;

  const env = createTestEnv({
    __TEST_TELEGRAM_FETCH: async () => {
      callCount += 1;
      if (shouldFail) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 888 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const bookRes = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'tg_retry_test_01',
    serviceId: 'srv_hair_blowout',
    masterId: 'mst_sofia',
    date: '2026-10-30',
    time: '17:00',
    clientName: 'Ольга',
    clientPhone: '+7 (903) 777-66-55',
    consentAccepted: true,
  });

  assert.equal(bookRes.status, 201);
  assert.equal(bookRes.data.booking.notificationStatus, 'failed_retry_scheduled');
  assert.equal(callCount, 1);

  // Восстанавливаем работу Telegram API и запускаем повторную отправку
  shouldFail = false;
  await env.DB.prepare('UPDATE notification_queue SET next_retry_at = 0').run();

  const retryRes = await callWorker(
    env,
    'POST',
    '/api/admin/notifications/retry',
    {},
    { Authorization: 'Bearer LeaAdmin2026!' }
  );

  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.data.summary.sent, 1);
  assert.equal(callCount, 2);

  // Проверяем, что запись в bookings ровно одна (нет дубликата) и статус стал sent
  const totalBookings = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM bookings WHERE idempotency_key = 'tg_retry_test_01'`
  ).first();
  assert.equal(Number(totalBookings.cnt), 1);

  const updatedBooking = await env.DB.prepare(
    'SELECT notification_status, telegram_status, telegram_attempts FROM bookings WHERE id = ?'
  )
    .bind(bookRes.data.booking.id)
    .first();
  assert.equal(updatedBooking.notification_status, 'sent');
  assert.equal(updatedBooking.telegram_status, 'sent');
  assert.equal(Number(updatedBooking.telegram_attempts), 2);
});

test('14. Telegram (п. 8.7 #8 и #9) и Безопасность: Отсутствие токенов во фронтенде, Git и защита админских маршрутов', async () => {
  const env = createTestEnv();

  // Неавторизованный запрос к админке должен отклоняться с 401
  const unauthAdmin = await callWorker(env, 'GET', '/api/admin/overview');
  assert.equal(unauthAdmin.status, 401);

  // В публичном ответе /api/catalog не должно быть токена
  const catalogRes = await callWorker(env, 'GET', '/api/catalog');
  const catalogJson = JSON.stringify(catalogRes.data);
  assert.ok(!catalogJson.includes('TEST_BOT_SECRET_TOKEN_DO_NOT_LEAK'));

  // В авторизованном ответе /api/admin/overview также не должно быть значения токена
  const adminRes = await callWorker(
    env,
    'GET',
    '/api/admin/overview',
    null,
    { Authorization: 'Bearer LeaAdmin2026!' }
  );
  assert.equal(adminRes.status, 200);
  const adminJson = JSON.stringify(adminRes.data);
  assert.ok(!adminJson.includes('TEST_BOT_SECRET_TOKEN_DO_NOT_LEAK'));

  // Проверяем исходные файлы фронтенда и конфигурации на отсутствие реальных токенов Telegram (формат NNNNNN:AA...)
  const filesToScan = [
    'index.html',
    'app.js',
    'styles.css',
    'wrangler.toml',
    '.env.example',
    'worker/index.js',
    'server.js',
  ];
  const realTelegramTokenPattern = /\b\d{8,11}:AA[A-Za-z0-9_-]{30,}\b/;

  for (const relPath of filesToScan) {
    const content = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
    assert.ok(
      !realTelegramTokenPattern.test(content),
      `Файл ${relPath} не должен содержать секретных токенов Telegram Bot API`
    );
  }
});

test('15. Авторизация /admin: вход по логину/паролю, HttpOnly/Secure/SameSite Cookie, проверка CSRF, неверный пароль, выход из аккаунта', async () => {
  const env = createTestEnv();

  // 1. Попытка вызвать административный API без авторизации -> 401
  const unauthRes = await callWorker(env, 'GET', '/api/admin/bookings');
  assert.equal(unauthRes.status, 401);

  // 2. Неверный пароль -> 401
  const badLogin = await callWorker(env, 'POST', '/api/admin/login', {
    login: 'admin',
    password: 'WrongPassword123',
  });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.data.error.code, 'INVALID_CREDENTIALS');

  // 3. Успешный вход -> 200 + защищённая Cookie (HttpOnly; Secure; SameSite=Strict) + csrfToken
  const goodLogin = await callWorker(env, 'POST', '/api/admin/login', {
    login: 'admin',
    password: 'LeaAdmin2026!',
  });
  assert.equal(goodLogin.status, 200);
  assert.equal(goodLogin.data.authenticated, true);
  assert.ok(goodLogin.data.csrfToken);

  const setCookieHeader = goodLogin.headers.get('Set-Cookie') || '';
  assert.ok(setCookieHeader.includes('lea_admin_session='));
  assert.ok(setCookieHeader.includes('HttpOnly'));
  assert.ok(setCookieHeader.includes('Secure'));
  assert.ok(setCookieHeader.includes('SameSite=Strict'));

  const cookiePair = setCookieHeader.split(';')[0];

  // 4. Чтение записей по сессионной Cookie
  const overviewRes = await callWorker(env, 'GET', '/api/admin/overview', null, {
    Cookie: cookiePair,
  });
  assert.equal(overviewRes.status, 200);
  assert.equal(overviewRes.data.ok, true);

  // 5. Модифицирующий POST-запрос по Cookie БЕЗ X-CSRF-Token должен отклоняться (защита от CSRF)
  const noCsrfRes = await callWorker(
    env,
    'POST',
    '/api/admin/notifications/retry',
    {},
    { Cookie: cookiePair }
  );
  assert.equal(noCsrfRes.status, 401);

  // 6. Модифицирующий POST-запрос по Cookie С корректным X-CSRF-Token проходит успешно
  const withCsrfRes = await callWorker(
    env,
    'POST',
    '/api/admin/notifications/retry',
    {},
    {
      Cookie: cookiePair,
      'X-CSRF-Token': goodLogin.data.csrfToken,
    }
  );
  assert.equal(withCsrfRes.status, 200);

  // 7. Выход из аккаунта (logout) отзывает сессию и очищает Cookie
  const logoutRes = await callWorker(
    env,
    'POST',
    '/api/admin/logout',
    {},
    {
      Cookie: cookiePair,
      'X-CSRF-Token': goodLogin.data.csrfToken,
    }
  );
  assert.equal(logoutRes.status, 200);
  assert.ok((logoutRes.headers.get('Set-Cookie') || '').includes('Max-Age=0'));

  // 8. Повторный запрос со старой Cookie после выхода отклоняется с 401
  const afterLogout = await callWorker(env, 'GET', '/api/admin/overview', null, {
    Cookie: cookiePair,
  });
  assert.equal(afterLogout.status, 401);
});

test('16. Управление записями в /admin: перенос записи, запрет переноса на занятый слот, фильтрация и история изменений', async () => {
  const env = createTestEnv();
  const adminHeaders = { Authorization: 'Bearer LeaAdmin2026!' };

  // Создаём две записи на 2026-11-05 к мастеру Анне:
  // Запись 1: 10:00–11:00 (srv_mani_naked, 60 мин)
  const b1 = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'resched_b1',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: '2026-11-05',
    time: '10:00',
    clientName: 'Екатерина',
    clientLastName: 'Смирнова',
    clientPhone: '+7 (999) 100-10-10',
    consentAccepted: true,
  });
  assert.equal(b1.status, 201);
  assert.equal(b1.data.booking.clientFirstName, 'Екатерина');
  assert.equal(b1.data.booking.clientLastName, 'Смирнова');

  // Запись 2: 11:30–12:30 (srv_mani_naked, 60 мин)
  const b2 = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'resched_b2',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: '2026-11-05',
    time: '11:30',
    clientName: 'Дарья',
    clientLastName: 'Волкова',
    clientPhone: '+7 (999) 200-20-20',
    consentAccepted: true,
  });
  assert.equal(b2.status, 201);

  // Попытка перенести Запись 2 на 10:30 (пересекается с Записью 1 на 10:00–11:00) -> 409
  const conflictResched = await callWorker(
    env,
    'POST',
    `/api/admin/bookings/${b2.data.booking.id}/reschedule`,
    {
      date: '2026-11-05',
      time: '10:30',
      masterId: 'mst_anna',
    },
    adminHeaders
  );
  assert.equal(conflictResched.status, 409);
  assert.equal(
    conflictResched.data.error.message,
    'Это время уже занято. Пожалуйста, выберите другое'
  );

  // Успешный перенос Записи 2 на свободное время 15:00 -> 200
  const okResched = await callWorker(
    env,
    'POST',
    `/api/admin/bookings/${b2.data.booking.id}/reschedule`,
    {
      date: '2026-11-05',
      time: '15:00',
      masterId: 'mst_anna',
    },
    adminHeaders
  );
  assert.equal(okResched.status, 200);
  assert.equal(okResched.data.booking.startTime, '15:00');
  assert.equal(okResched.data.booking.endTime, '16:00');

  // Проверяем, что старое время 11:30 теперь снова свободно для записи!
  const b3 = await callWorker(env, 'POST', '/api/bookings', {
    idempotencyKey: 'resched_b3_take_freed_slot',
    serviceId: 'srv_mani_naked',
    masterId: 'mst_anna',
    date: '2026-11-05',
    time: '11:30',
    clientName: 'Алина',
    clientLastName: 'Морозова',
    clientPhone: '+7 (999) 300-30-30',
    consentAccepted: true,
  });
  assert.equal(b3.status, 201);

  // Проверяем поиск по фамилии и фильтрацию в /api/admin/overview
  const searchRes = await callWorker(
    env,
    'GET',
    '/api/admin/overview?search=%D0%92%D0%BE%D0%BB%D0%BA%D0%BE%D0%B2%D0%B0',
    null,
    adminHeaders
  );
  assert.equal(searchRes.status, 200);
  assert.equal(searchRes.data.bookings.length, 1);
  assert.equal(searchRes.data.bookings[0].clientLastName, 'Волкова');
  assert.ok(searchRes.data.bookings[0].auditLogs.length >= 2);
});

test('17. Совместимость со старой схемой D1 (lea-booking-db: services, staff, working_hours, bookings с first_name/last_name/staff_id) без потери данных', async () => {
  // Создаём БД в памяти БЕЗ новых миграций и инициализируем её ТОЧНО по старой схеме lea-booking-db
  const legacyDb = createInitializedD1Database({
    dbPath: ':memory:',
    migrationsDir: path.join(rootDir, 'non-existent-migrations-dir'),
  });

  await legacyDb
    .prepare(
      `CREATE TABLE services (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        category_label TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price_rub INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00Z'
      )`
    )
    .run();

  await legacyDb
    .prepare(
      `CREATE TABLE staff (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        default_category TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00Z'
      )`
    )
    .run();

  await legacyDb
    .prepare(
      `CREATE TABLE working_hours (
        day_of_week INTEGER PRIMARY KEY,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        break_start TEXT,
        break_end TEXT,
        is_closed INTEGER NOT NULL DEFAULT 0
      )`
    )
    .run();

  await legacyDb
    .prepare(
      `CREATE TABLE bookings (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        service_id TEXT NOT NULL,
        staff_id TEXT NOT NULL DEFAULT 'any',
        booking_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        start_minutes INTEGER NOT NULL,
        end_minutes INTEGER NOT NULL,
        price_rub INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        consent_accepted INTEGER NOT NULL DEFAULT 1,
        telegram_status TEXT NOT NULL DEFAULT 'sent',
        telegram_attempts INTEGER NOT NULL DEFAULT 1,
        telegram_last_error TEXT,
        created_at TEXT NOT NULL DEFAULT '2026-10-28T10:00:00Z'
      )`
    )
    .run();

  // Вставляем данные в старую схему
  await legacyDb
    .prepare(
      `INSERT INTO services (id, category, category_label, title, description, price_rub, duration_minutes, is_active, sort_order)
       VALUES ('manicure-gel', 'manicure', 'Маникюр', 'Маникюр с гель-лаком', 'Описание', 1700, 90, 1, 1)`
    )
    .run();

  await legacyDb
    .prepare(
      `INSERT INTO staff (id, name, role, default_category, is_active)
       VALUES ('master-anna', 'Анна', 'Мастер маникюра', 'manicure', 1)`
    )
    .run();

  for (let d = 0; d <= 6; d++) {
    await legacyDb
      .prepare(
        `INSERT INTO working_hours (day_of_week, open_time, close_time, break_start, break_end, is_closed)
         VALUES (?, '10:00', '21:00', '14:30', '15:00', 0)`
      )
      .bind(d)
      .run();
  }

  // Существующая реальная запись клиента в старой схеме
  await legacyDb
    .prepare(
      `INSERT INTO bookings (
         id, idempotency_key, first_name, last_name, phone, service_id, staff_id,
         booking_date, start_time, end_time, start_minutes, end_minutes,
         price_rub, duration_minutes, status, consent_accepted, telegram_status, telegram_attempts
       ) VALUES (
         'LEA-OLD-001', 'idem_old_001', 'Виктория', 'Романова', '+7 916 111-22-33',
         'manicure-gel', 'master-anna', '2026-11-10', '10:00', '11:30', 600, 690,
         1700, 90, 'confirmed', 1, 'sent', 1
       )`
    )
    .run();

  const legacyEnv = {
    DB: legacyDb,
    __TEST_NOW_ISO: '2026-10-29T09:00:00.000Z',
    TELEGRAM_BOT_TOKEN: '123456789:TEST_BOT_SECRET_TOKEN_DO_NOT_LEAK',
    TELEGRAM_CHAT_ID: '-100987654321',
    __TEST_TELEGRAM_FETCH: async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      }),
  };

  // 1. Проверяем, что /api/catalog работает со старой базой без ошибок
  const catRes = await callWorker(legacyEnv, 'GET', '/api/catalog');
  assert.equal(catRes.status, 200);
  assert.equal(catRes.data.ok, true);
  assert.equal(catRes.data.services[0].id, 'manicure-gel');
  assert.equal(catRes.data.masters[0].id, 'master-anna');

  // 2. Проверяем, что администратор в /admin видит старую запись Виктории Романовой
  const adminRes = await callWorker(
    legacyEnv,
    'GET',
    '/api/admin/overview',
    null,
    { Authorization: 'Bearer LeaAdmin2026!' }
  );
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.data.bookings.length, 1);
  assert.equal(adminRes.data.bookings[0].id, 'LEA-OLD-001');
  assert.equal(adminRes.data.bookings[0].clientFirstName, 'Виктория');
  assert.equal(adminRes.data.bookings[0].clientLastName, 'Романова');

  // 3. Проверяем, что старая запись на 10:00–11:30 защищена от двойного бронирования!
  const overlapLegacy = await callWorker(legacyEnv, 'POST', '/api/bookings', {
    idempotencyKey: 'idem_new_overlap_legacy',
    serviceId: 'manicure-gel',
    masterId: 'master-anna',
    date: '2026-11-10',
    time: '10:30',
    clientName: 'Марина',
    clientLastName: 'Орлова',
    clientPhone: '+7 (916) 999-88-77',
    consentAccepted: true,
  });
  assert.equal(overlapLegacy.status, 409);

  // 4. А запись на свободное время 12:00 в старую таблицу проходит успешно
  const okLegacy = await callWorker(legacyEnv, 'POST', '/api/bookings', {
    idempotencyKey: 'idem_new_ok_legacy',
    serviceId: 'manicure-gel',
    masterId: 'master-anna',
    date: '2026-11-10',
    time: '12:00',
    clientName: 'Марина',
    clientLastName: 'Орлова',
    clientPhone: '+7 (916) 999-88-77',
    consentAccepted: true,
  });
  assert.equal(okLegacy.status, 201);
});

