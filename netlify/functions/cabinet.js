// =============================================================================
//  POST /api/cabinet — личный кабинет клиента
// =============================================================================
//  Действия (передаются полем action):
//    start   — выдать одноразовый код и ссылку на бота
//    poll    — проверить, подтвердил ли клиент номер в боте; если да, выдать
//              cookie сессии
//    me      — вернуть данные кабинета: имя, будущие записи, история
//    logout  — закрыть сессию
//    setup   — разово подключить вебхук бота (нужен ключ, см. ниже)
//
//  Что кабинет НЕ делает: не показывает ничего, что не относится к самому
//  клиенту. Запросы к базе всегда ограничены телефоном из сессии.
// =============================================================================

const {
  CONFIG,
  clean,
  connect,
  corsHeaders,
  fail,
  jsonResponse,
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
    `SELECT a.date, a.time, a.duration, a.status, a.price,
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
      date: r.date,
      time: r.time,
      duration: Number(r.duration) || 0,
      status: r.status || '',
      price: Number(r.price) || 0,
      serviceName: r.servicesLabel
        || (r.parentName ? r.parentName + ' — ' + r.serviceName : r.serviceName),
      masterName: r.masterName,
    };
    if (r.date >= today) upcoming.push(item);
    else past.push(item);
  });

  upcoming.reverse(); // ближайшая запись первой
  return { upcoming, past };
}

const CANCELLED = ['Отменён клиентом', 'Отменён салоном', 'Не пришёл'];

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
        upcoming: visits.upcoming,
        past: visits.past,
        stats: {
          visits: done.length,
          spent,
          since: done.length ? done[done.length - 1].date : '',
        },
      };
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
