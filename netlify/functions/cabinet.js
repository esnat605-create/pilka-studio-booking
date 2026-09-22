// =============================================================================
//  POST /api/cabinet — личный кабинет клиента
// =============================================================================
//  Действия (передаются полем action):
//    start   — выдать одноразовый код и ссылку на бота
//    poll    — проверить, подтвердил ли клиент номер в боте; если да, выдать
//              cookie сессии
//    me      — вернуть данные кабинета: имя, будущие записи, история
//    slots   — свободное время для переноса своей записи на выбранную дату
//    reschedule — перенести свою запись на другую дату/время (тот же мастер
//              и те же услуги)
//    cancel  — отменить свою запись (статус «Отменён клиентом»; запись не
//              стирается — администратор видит отмену, слот освобождается)
//    logout  — закрыть сессию
//    setup   — разово подключить вебхук бота (нужен ключ, см. ниже)
//
//  Что кабинет НЕ делает: не показывает ничего, что не относится к самому
//  клиенту. Запросы к базе всегда ограничены телефоном из сессии.
// =============================================================================

const {
  CONFIG,
  apptStartMs,
  clean,
  computeFreeSlots,
  connect,
  corsHeaders,
  daysBetween,
  fail,
  isValidDateStr,
  isValidTimeStr,
  jsonResponse,
  loadBusyIntervals,
  loadDaysOff,
  loadMasters,
  loadSettings,
  phoneKey,
  salonNow,
  withDb,
} = require('./lib/core.js');
const {
  botUsername,
  callTelegram,
  isConfigured,
  newNonce,
  newSessionToken,
  webhookSecret,
} = require('./lib/telegram.js');

const COOKIE = 'pilka_client';
const SESSION_DAYS = 60;
const NONCE_TTL_MINUTES = 15;

// Адрес вебхука на этом же сайте. Заголовки Netlify надёжнее, чем что-либо
// зашитое в код: домен сайта может смениться.
function expectedWebhookUrl(event) {
  const h = (event && event.headers) || {};
  const proto = h['x-forwarded-proto'] || 'https';
  const host = h['x-forwarded-host'] || h.host || '';
  return proto + '://' + host + '/api/tg-webhook';
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i === -1) return;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function setCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function currentPhone(event, client) {
  const cookies = parseCookies((event.headers && (event.headers.cookie || event.headers.Cookie)) || '');
  const token = cookies[COOKIE];
  if (!token) return null;
  const res = await client.query(
    'SELECT phone FROM client_sessions WHERE token = $1 AND expires_at > now()',
    [token]
  );
  return res.rows.length ? res.rows[0].phone : null;
}

// Записи клиента: будущие и прошедшие, с названиями услуги и мастера.
// Служебные поля (проценты мастера, себестоимость, заметки администратора)
// наружу не отдаются — клиенту они не предназначены.
async function loadVisits(client, phone) {
  const key = phoneKey(phone);
  // Визит может состоять из нескольких услуг подряд — тогда собираем их
  // названия в порядке оказания. У записей, сделанных до появления такой
  // возможности, состава нет, и мы берём единственную услугу самой записи:
  // иначе в кабинете у старых визитов пропала бы услуга.
  const res = await client.query(
    `SELECT a.id, a.date, a.time, a.duration, a.status, a.price,
            coalesce(s.name, '')  AS "serviceName",
            coalesce(ps.name, '') AS "parentName",
            coalesce(m.name, '')  AS "masterName",
            (SELECT string_agg(
                      CASE WHEN cp.name IS NOT NULL AND cp.name <> ''
                           THEN cp.name || ' — ' || cs.name ELSE cs.name END,
                      ' + ' ORDER BY aps.position)
               FROM appointment_services aps
               JOIN services cs  ON cs.id = aps.service_id
               LEFT JOIN services cp ON cp.id = nullif(cs.parent_id, '')
              WHERE aps.appointment_id = a.id) AS "servicesLabel"
       FROM appointments a
       LEFT JOIN services s  ON s.id = a.service_id
       LEFT JOIN services ps ON ps.id = s.parent_id
       LEFT JOIN masters  m  ON m.id = a.master_id
      WHERE regexp_replace(a.phone, '\\D', '', 'g') LIKE $1
      ORDER BY a.date DESC, a.time DESC
      LIMIT 200`,
    ['%' + key]
  );

  const today = salonNow().date;
  const upcoming = [];
  const past = [];

  res.rows.forEach((r) => {
    const item = {
      id: r.id,
      date: r.date,
      time: r.time,
      duration: Number(r.duration) || 0,
      status: r.status || '',
      price: Number(r.price) || 0,
      serviceName: r.servicesLabel
        || (r.parentName ? r.parentName + ' — ' + r.serviceName : r.serviceName),
      masterName: r.masterName,
      // Можно ли отменить или перенести запись прямо из кабинета.
      canChange: canClientChange(r),
    };
    if (r.date >= today) upcoming.push(item);
    else past.push(item);
  });

  upcoming.reverse(); // ближайшая запись первой
  return { upcoming, past };
}

const CANCELLED = ['Отменён клиентом', 'Отменён салоном', 'Не пришёл'];

// Статусы, при которых клиент может сам отменить или перенести запись.
// «Оказана услуга» и отменённые — уже нельзя.
const CLIENT_CHANGEABLE = ['Записан', 'Подтверждён', 'Не подтверждён'];

// Отменить или перенести запись онлайн можно не позже чем за столько минут до
// визита (по умолчанию 2 часа — то же значение, что и минимальный запас при
// новой записи, BOOKING_LEAD_MINUTES). Позже — только через WhatsApp.
function canClientChange(appt) {
  if (CLIENT_CHANGEABLE.indexOf(String(appt.status || '').trim()) === -1) return false;
  return apptStartMs(appt.date, appt.time) - Date.now() >= CONFIG.leadMinutes * 60 * 1000;
}

const CHANGE_TOO_LATE =
  'Отменить или перенести запись онлайн можно не позже чем за 2 часа до визита. ' +
  'Напишите нам в WhatsApp — поможем.';

// Отметка времени по часам салона для заметки в записи: «2026-09-22 14:05».
function salonStamp() {
  const d = new Date(Date.now() + CONFIG.tzOffsetHours * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function ruDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  return `${d}.${m}.${y}`;
}

// Запись, принадлежащая клиенту из сессии. Принадлежность проверяется по
// телефону (последние 10 цифр) — ровно так же, как собирается список записей.
// Чужую запись по id получить нельзя: для неё ответ «не найдена».
async function loadOwnAppointment(client, phone, id, forUpdate) {
  const key = phoneKey(phone);
  if (!id || key.length < 10) fail('Запись не найдена', 404, 'not_found');
  const res = await client.query(
    `SELECT id, date, time, duration, master_id AS "masterId", status,
            coalesce(reminder_sent, 'Нет') AS "reminderSent"
       FROM appointments
      WHERE id = $1 AND regexp_replace(phone, '\\D', '', 'g') LIKE $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id, '%' + key]
  );
  if (!res.rows.length) fail('Запись не найдена', 404, 'not_found');
  return res.rows[0];
}

// Проверка даты, на которую клиент хочет перенести запись.
function checkNewDate(date) {
  if (!isValidDateStr(date)) fail('Выберите дату', 400, 'bad_date', 'date');
  const shift = daysBetween(salonNow().date, date);
  if (shift < 0) fail('Эта дата уже прошла — выберите другую', 400, 'date_past', 'date');
  if (shift > CONFIG.horizonDays) fail(`Запись открыта на ${CONFIG.horizonDays} дней вперёд`, 400, 'date_far', 'date');
}

// Свободное время у мастера этой записи на дату — той же функцией, что и при
// новой записи с сайта (выходные, часы работы, фиксированное время приёма,
// занятость). Сама переносимая запись занятостью не считается.
async function freeSlotsForMove(client, appt, date) {
  const [settings, masters] = await Promise.all([loadSettings(client), loadMasters(client)]);
  const master = masters.find((m) => m.id === appt.masterId);
  if (!master) {
    fail('Перенести эту запись онлайн нельзя — напишите нам в WhatsApp, подберём время.', 409, 'master_unavailable');
  }
  const [busy, daysOff] = await Promise.all([
    loadBusyIntervals(client, appt.masterId, date, appt.id),
    loadDaysOff(client, appt.masterId),
  ]);
  const durationMin = Math.max(5, parseInt(appt.duration, 10) || 30);
  return {
    slots: computeFreeSlots({ settings, master, durationMin, date, busy, daysOff }),
    dayOff: daysOff.indexOf(date) !== -1,
  };
}

// Диагностика и подключение вебхука не трогают базу — это разговор с Telegram.
// Поэтому они обрабатываются ДО withDb: если база вдруг недоступна,
// диагностика всё равно должна ответить, иначе она бесполезна ровно тогда,
// когда нужнее всего.
async function handleTelegramSetup(event, action, body) {
  if (clean(body.key, 128) !== webhookSecret() || !webhookSecret()) {
    return jsonResponse(event, 403, { ok: false, error: 'Неверный ключ', code: 'forbidden' });
  }

  if (action === 'diag') {
    const info = await callTelegram('getWebhookInfo', {});
    const me = await callTelegram('getMe', {});
    return jsonResponse(event, 200, {
      ok: true,
      env: {
        TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || '(не задана)',
        TELEGRAM_WEBHOOK_SECRET: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      },
      expectedWebhook: expectedWebhookUrl(event),
      getMe: me && me.ok ? { username: me.result.username, id: me.result.id } : me,
      webhookInfo: info && info.ok ? info.result : info,
    });
  }

  // setup
  if (!isConfigured()) {
    return jsonResponse(event, 500, {
      ok: false, code: 'config_error',
      error: 'Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_BOT_USERNAME',
    });
  }
  const url = clean(body.url, 300) || expectedWebhookUrl(event);
  const setResult = await callTelegram('setWebhook', {
    url,
    secret_token: webhookSecret(),
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  // Перечитываем состояние: важно не «что мы отправили», а что Telegram запомнил.
  const info = await callTelegram('getWebhookInfo', {});
  return jsonResponse(event, 200, {
    ok: true,
    webhookUrl: url,
    setResult,
    webhookInfo: info && info.ok ? info.result : info,
  });
}

const withDbHandler = withDb(
  async function (event, client) {
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      fail('Некорректный запрос');
    }
    const action = clean(body.action, 32);

    // ---- начать вход -----------------------------------------------------
    if (action === 'start') {
      if (!isConfigured()) {
        fail('Вход через Telegram пока не настроен. Позвоните нам — запишем вручную.', 503, 'tg_not_configured');
      }
      // Чистим протухшие коды, чтобы таблица не росла бесконечно.
      await client.query(
        `DELETE FROM client_auth WHERE created_at < now() - interval '1 day'`
      );
      const nonce = newNonce();
      await client.query('INSERT INTO client_auth (nonce) VALUES ($1)', [nonce]);
      return {
        nonce,
        link: 'https://t.me/' + botUsername() + '?start=' + nonce,
        botUsername: botUsername(),
        ttlMinutes: NONCE_TTL_MINUTES,
      };
    }

    // ---- проверить подтверждение ----------------------------------------
    if (action === 'poll') {
      const nonce = clean(body.nonce, 64);
      if (!nonce) fail('Не указан код входа');

      const res = await client.query(
        `SELECT phone, telegram_id AS "telegramId", status, tg_name AS "tgName"
           FROM client_auth
          WHERE nonce = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
        [nonce, String(NONCE_TTL_MINUTES)]
      );
      if (!res.rows.length) return { state: 'expired' };
      const row = res.rows[0];
      if (row.status !== 'confirmed') return { state: 'pending' };

      // Код одноразовый: сразу закрываем, чтобы повторно им войти было нельзя.
      await client.query(`UPDATE client_auth SET status = 'used' WHERE nonce = $1`, [nonce]);

      const token = newSessionToken();
      await client.query(
        `INSERT INTO client_sessions (token, phone, telegram_id, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
        [token, row.phone, row.telegramId || '', String(SESSION_DAYS)]
      );

      // Если клиента ещё нет в базе — заводим карточку, чтобы будущие записи
      // сразу к ней привязывались.
      const key = phoneKey(row.phone);
      const exists = await client.query(
        `SELECT id FROM clients WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1 LIMIT 1`,
        ['%' + key]
      );
      if (!exists.rows.length) {
        await client.query(
          `INSERT INTO clients (id, name, phone, consent, telegram_id)
           VALUES ($1, $2, $3, 'Да', $4)`,
          ['c' + newNonce().slice(0, 12), clean(row.tgName, 120) || 'Клиент', row.phone, row.telegramId || '']
        );
      }

      return jsonResponse(event, 200, { ok: true, state: 'ready' }, { 'Set-Cookie': setCookie(token) });
    }

    // ---- данные кабинета -------------------------------------------------
    if (action === 'me') {
      const phone = await currentPhone(event, client);
      if (!phone) return { authorized: false };

      const key = phoneKey(phone);
      const who = await client.query(
        `SELECT name FROM clients WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1
          ORDER BY updated_at DESC LIMIT 1`,
        ['%' + key]
      );
      const visits = await loadVisits(client, phone);

      const done = visits.past.filter((v) => CANCELLED.indexOf(v.status) === -1);
      const spent = done.reduce((sum, v) => sum + v.price, 0);

      return {
        authorized: true,
        client: { name: (who.rows[0] && who.rows[0].name) || 'Клиент', phone },
        // Для выбора даты при переносе: сегодня по часам салона и горизонт записи.
        today: salonNow().date,
        horizonDays: CONFIG.horizonDays,
        upcoming: visits.upcoming,
        past: visits.past,
        stats: {
          visits: done.length,
          spent,
          since: done.length ? done[done.length - 1].date : '',
        },
      };
    }

    // ---- свободное время для переноса ------------------------------------
    if (action === 'slots') {
      const phone = await currentPhone(event, client);
      if (!phone) fail('Войдите в кабинет заново', 401, 'unauthorized');
      const appt = await loadOwnAppointment(client, phone, clean(body.id, 32), false);
      if (!canClientChange(appt)) fail(CHANGE_TOO_LATE, 409, 'too_late');
      const date = clean(body.date, 10);
      checkNewDate(date);
      const r = await freeSlotsForMove(client, appt, date);
      // Текущее время самой записи в этот же день не предлагаем — это не перенос.
      const slots = date === appt.date ? r.slots.filter((t) => t !== appt.time) : r.slots;
      return { date, slots, dayOff: r.dayOff };
    }

    // ---- перенос записи ----------------------------------------------------
    if (action === 'reschedule') {
      const phone = await currentPhone(event, client);
      if (!phone) fail('Войдите в кабинет заново', 401, 'unauthorized');
      const id = clean(body.id, 32);
      const date = clean(body.date, 10);
      const time = clean(body.time, 5);
      checkNewDate(date);
      if (!isValidTimeStr(time)) fail('Выберите время', 400, 'bad_time', 'time');

      // Мастер нужен до транзакции — для ключа блокировки.
      const pre = await loadOwnAppointment(client, phone, id, false);

      await client.query('BEGIN');
      try {
        // Та же блокировка (мастер, дата), что и при новой записи с сайта:
        // перенос и чужая запись на то же время не проскочат одновременно.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pilka:${pre.masterId}:${date}`]);
        const appt = await loadOwnAppointment(client, phone, id, true);
        if (appt.masterId !== pre.masterId) fail('Запись изменилась — обновите страницу', 409, 'changed');
        if (!canClientChange(appt)) fail(CHANGE_TOO_LATE, 409, 'too_late');
        if (appt.date === date && appt.time === time) fail('Это и так время вашей записи', 400, 'same_time', 'time');

        const r = await freeSlotsForMove(client, appt, date);
        if (r.slots.indexOf(time) === -1) {
          fail('Это время уже занято или недоступно. Выберите другое — список обновлён.', 409, 'slot_taken', 'time');
        }

        // Напоминание за 24 часа должно прийти к НОВОМУ времени. «Не требуется»,
        // выбранное администратором, не трогаем.
        let reminder = appt.reminderSent;
        if (reminder !== 'Не требуется') {
          reminder = apptStartMs(date, time) - Date.now() < 24 * 3600 * 1000 ? 'Да' : 'Нет';
        }
        const note = `Перенесено клиентом через личный кабинет ${salonStamp()}: было ${ruDate(appt.date)} ${appt.time}`;

        // Статус — «Не подтверждён»: администратор увидит перенос в сетке (как
        // заявку с сайта) и подтвердит новое время звонком.
        await client.query(
          `UPDATE appointments
              SET date = $1, time = $2, status = 'Не подтверждён', reminder_sent = $3,
                  notes = CASE WHEN coalesce(notes, '') = '' THEN $4 ELSE notes || E'\\n' || $4 END,
                  updated_at = now()
            WHERE id = $5`,
          [date, time, reminder, note, appt.id]
        );
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* соединение могло отвалиться */ }
        throw err;
      }
      return { rescheduled: true, date, time };
    }

    // ---- отмена записи -----------------------------------------------------
    if (action === 'cancel') {
      const phone = await currentPhone(event, client);
      if (!phone) fail('Войдите в кабинет заново', 401, 'unauthorized');
      const appt = await loadOwnAppointment(client, phone, clean(body.id, 32), false);
      if (!canClientChange(appt)) fail(CHANGE_TOO_LATE, 409, 'too_late');
      const note = `Отменено клиентом через личный кабинет ${salonStamp()}`;
      // Запись не удаляем: статус «Отменён клиентом» освобождает время в сетке
      // (и на сайте, и в админке), а история и заметка остаются.
      await client.query(
        `UPDATE appointments
            SET status = 'Отменён клиентом',
                notes = CASE WHEN coalesce(notes, '') = '' THEN $1 ELSE notes || E'\\n' || $1 END,
                updated_at = now()
          WHERE id = $2`,
        [note, appt.id]
      );
      return { cancelled: true };
    }

    // ---- выход ------------------------------------------------------------
    if (action === 'logout') {
      const cookies = parseCookies((event.headers && (event.headers.cookie || event.headers.Cookie)) || '');
      if (cookies[COOKIE]) {
        await client.query('DELETE FROM client_sessions WHERE token = $1', [cookies[COOKIE]]);
      }
      return jsonResponse(event, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }

    return fail('Неизвестное действие');
  },
  { method: 'POST' }
);

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }
  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
    const action = String(body.action || '');
    if (action === 'diag' || action === 'setup') {
      try {
        return await handleTelegramSetup(event, action, body);
      } catch (err) {
        console.error('[cabinet] диагностика упала:', err);
        return jsonResponse(event, 500, { ok: false, error: String(err && err.message) });
      }
    }
  }
  return withDbHandler(event);
};
