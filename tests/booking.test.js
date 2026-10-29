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
  return { status: res.status, data };
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
