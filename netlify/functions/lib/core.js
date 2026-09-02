// =============================================================================
//  Общий модуль для всех серверных функций страницы записи Pilka Studio.
// =============================================================================
//  Здесь собрано всё, что нужно больше чем одной функции: подключение к базе,
//  чтение настроек салона, работа со временем в часовом поясе салона, расчёт
//  свободных слотов, нормализация телефона и стандартные HTTP-ответы.
//
//  Файл лежит в подпапке lib/, поэтому Netlify не считает его отдельной
//  функцией-эндпоинтом и просто вкомпилирует его в те функции, которые его
//  подключают.
// =============================================================================

const { Client } = require('pg');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
//  Константы предметной области — согласованы с существующей админкой салона
// -----------------------------------------------------------------------------

// Статусы, которые НЕ занимают время в сетке: отменённая запись или неявка
// освобождают слот, и на него можно записаться заново. Ровно этот же список
// зашит в админке (NON_CONFLICTING_STATUSES в index.html) — если он там
// когда-нибудь изменится, надо поменять и здесь.
const NON_CONFLICTING_STATUSES = new Set([
  'Отменён клиентом',
  'Отменён салоном',
  'Не пришёл',
]);

// Статус, с которым создаётся запись, пришедшая с сайта. Такой статус уже
// существует в админке (иконка «не дозвонились до клиента»), он занимает слот
// и визуально отличается от подтверждённых записей — то, что нужно для заявки,
// которую администратор ещё должен проверить и подтвердить звонком.
const WEB_BOOKING_STATUS = 'Не подтверждён';

// Значение поля source у таких записей — по нему администратор может отфильтровать
// в админке всё, что пришло с сайта.
const WEB_BOOKING_SOURCE = 'Сайт';

// Кто «создал» запись — попадает в столбец created_by рядом с логинами админов.
const WEB_BOOKING_AUTHOR = 'сайт';

// Значения по умолчанию, если в таблице settings салона что-то не заполнено.
// Совпадают с дефолтами админки.
const DEFAULT_SETTINGS = {
  salonName: 'Pilka Studio',
  openTime: '09:00',
  closeTime: '20:00',
  stepMinutes: 30,
  earlyOpenTime: '04:00',
};

// Шаг сетки времени на сайте берётся из ОТДЕЛЬНОЙ настройки siteStepMinutes,
// а не из stepMinutes. Причина: stepMinutes управляет масштабом сетки в
// админке, и администратор меняет его как ему удобно (сейчас там 60 минут).
// Сайт от этого зависеть не должен — клиенту нужны получасовые интервалы
// независимо от того, как администратору удобнее смотреть свою таблицу.
const DEFAULT_SITE_STEP_MINUTES = 30;

// -----------------------------------------------------------------------------
//  Настройки через переменные окружения Netlify
// -----------------------------------------------------------------------------

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

const CONFIG = {
  // Часовой пояс салона в часах от UTC. Сухум — UTC+4, перевода часов нет.
  tzOffsetHours: envInt('SALON_TZ_OFFSET', 4),
  // На сколько дней вперёд открыта запись.
  horizonDays: envInt('BOOKING_HORIZON_DAYS', 60),
  // Минимальный запас времени до ближайшей записи (минуты). Нельзя записаться
  // «через пять минут» — у салона должно быть время увидеть заявку.
  leadMinutes: envInt('BOOKING_LEAD_MINUTES', 120),
  // Антиспам: сколько заявок с одного номера телефона допускается за сутки.
  maxPerPhonePerDay: envInt('MAX_BOOKINGS_PER_PHONE_PER_DAY', 3),
  // Антиспам: сколько будущих активных записей может одновременно висеть на одном номере.
  maxActiveFuture: envInt('MAX_ACTIVE_FUTURE_PER_PHONE', 3),
  // Разрешённый источник запросов (CORS). По умолчанию — тот же домен.
  allowedOrigin: process.env.ALLOWED_ORIGIN || '',
};

// -----------------------------------------------------------------------------
//  Ошибки и HTTP-ответы
// -----------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, statusCode = 400, code = 'bad_request', field = '') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.field = field;
  }
}

function fail(message, statusCode = 400, code = 'bad_request', field = '') {
  throw new ApiError(message, statusCode, code, field);
}

// Заголовки CORS. Страница и функции живут на одном домене, поэтому CORS
// формально не нужен — но заголовки выставляем явно, чтобы фронтенд работал и
// при локальной отладке (netlify dev на другом порту), и если страницу когда-то
// встроят на домен салона.
function corsHeaders(event) {
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  let allow = '*';
  if (CONFIG.allowedOrigin) {
    // Разрешаем только явно заданный origin; всем остальным отдаём его же —
    // браузер сам отклонит несовпадение.
    allow = CONFIG.allowedOrigin;
  } else if (origin) {
    allow = origin;
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(event, statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        // Ответы содержат актуальную занятость — кэшировать их нельзя.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      corsHeaders(event),
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}

// Единая обёртка вокруг обработчика: preflight, подключение к базе, гарантированное
// закрытие соединения и превращение ApiError в аккуратный JSON.
function withDb(handlerFn, options) {
  const opts = options || {};
  const method = opts.method || 'GET';

  return async function (event) {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: corsHeaders(event), body: '' };
    }
    if (event.httpMethod !== method) {
      return jsonResponse(event, 405, { ok: false, error: 'Метод не поддерживается' });
    }

    let client = null;
    try {
      client = await connect();
      const result = await handlerFn(event, client);
      // Обработчик может вернуть уже готовый ответ — например, когда нужно
      // выставить cookie. Такой ответ отдаём как есть, иначе он завернулся бы
      // в тело второй раз и на клиент пришёл бы мусор.
      if (result && typeof result === 'object' && result.statusCode && 'body' in result) {
        return result;
      }
      return jsonResponse(event, 200, Object.assign({ ok: true }, result));
    } catch (err) {
      const isApi = err instanceof ApiError;
      if (!isApi) {
        // Внутренние ошибки пишем в лог Netlify целиком, наружу отдаём общий текст:
        // клиенту не нужно видеть детали устройства базы.
        console.error('[pilka-studio-booking] Необработанная ошибка:', err);
      }
      return jsonResponse(event, isApi ? err.statusCode : 500, {
        ok: false,
        error: isApi ? err.message : 'Внутренняя ошибка сервера. Попробуйте позже или позвоните нам.',
        code: isApi ? err.code : 'internal_error',
        field: isApi ? err.field : '',
      });
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (_) {
          /* соединение уже закрыто — ничего страшного */
        }
      }
    }
  };
}

// -----------------------------------------------------------------------------
//  Подключение к базе
// -----------------------------------------------------------------------------

async function connect() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    fail(
      'Сайт ещё не настроен: не задана переменная окружения DATABASE_URL.',
      500,
      'config_error'
    );
  }
  const client = new Client({
    connectionString: connStr,
    ssl: connStr.includes('localhost') || connStr.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    // Публичная страница не должна «висеть» — лучше быстро отдать ошибку.
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
    statement_timeout: 8000,
  });
  await client.connect();
  return client;
}

function uid(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

// -----------------------------------------------------------------------------
//  Время в часовом поясе салона
// -----------------------------------------------------------------------------
//  Серверы Netlify работают в UTC, а салон живёт по UTC+4. Чтобы не зависеть от
//  часового пояса сервера и от того, что подсунул браузер клиента, всё «сегодня»
//  и «сейчас» считаем сами: берём момент времени UTC и сдвигаем на смещение
//  салона. Дата и время хранятся в базе строками 'YYYY-MM-DD' и 'HH:MM' —
//  ровно так, как их пишет существующая админка.

function salonNow() {
  const nowUtcMs = Date.now();
  const shifted = new Date(nowUtcMs + CONFIG.tzOffsetHours * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTimeStr(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(s);
}

function timeToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Разница в днях между двумя датами 'YYYY-MM-DD' (b - a).
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// -----------------------------------------------------------------------------
//  Телефон
// -----------------------------------------------------------------------------
//  Нормализуем к формату E.164 (+7XXXXXXXXXX). Это не только аккуратнее для
//  админа, но и обязательное условие, если позже подключать напоминания через
//  WhatsApp Business API — там принимается только E.164.
//
//  Абхазия использует российский код +7 (мобильные — +7 940 XXXXXXX), поэтому
//  номер из 10 цифр и номер, начинающийся с 8, приводим к +7.

function normalizePhone(raw) {
  const input = String(raw || '').trim();
  const hasPlus = input.startsWith('+');
  const digits = input.replace(/\D/g, '');

  if (!digits) return { ok: false, reason: 'Введите номер телефона' };
  if (digits.length < 10) return { ok: false, reason: 'Номер слишком короткий — укажите его полностью' };
  if (digits.length > 15) return { ok: false, reason: 'Номер слишком длинный — проверьте его' };

  // Номер уже записан в международном виде (клиент сам поставил «+»).
  if (hasPlus) return { ok: true, phone: '+' + digits };

  // 8 900 000-00-00 → +7 900 000-00-00
  if (digits.length === 11 && digits.startsWith('8')) return { ok: true, phone: '+7' + digits.slice(1) };
  // 7 900 000-00-00 → +7 900 000-00-00
  if (digits.length === 11 && digits.startsWith('7')) return { ok: true, phone: '+' + digits };
  // 940 000-00-00 → +7 940 000-00-00
  if (digits.length === 10) return { ok: true, phone: '+7' + digits };

  // Всё остальное считаем международным номером как есть.
  return { ok: true, phone: '+' + digits };
}

// Последние 10 цифр номера — по ним ищем клиента в базе. Так «+7 940 1234567»,
// «8 940 123-45-67» и «9401234567» опознаются как один и тот же человек, и в
// таблице clients не появляется дубль карточки.
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// -----------------------------------------------------------------------------
//  Данные салона
// -----------------------------------------------------------------------------

async function loadSettings(client) {
  const res = await client.query('SELECT k, v FROM settings');
  const raw = {};
  res.rows.forEach((r) => {
    raw[r.k] = r.v;
  });
  const siteStep = parseInt(raw.siteStepMinutes, 10);
  return {
    salonName: raw.salonName || DEFAULT_SETTINGS.salonName,
    openTime: isValidTimeStr(raw.openTime) ? raw.openTime : DEFAULT_SETTINGS.openTime,
    closeTime: isValidTimeStr(raw.closeTime) ? raw.closeTime : DEFAULT_SETTINGS.closeTime,
    earlyOpenTime: isValidTimeStr(raw.earlyOpenTime) ? raw.earlyOpenTime : DEFAULT_SETTINGS.earlyOpenTime,
    // Намеренно НЕ читаем stepMinutes — см. комментарий у DEFAULT_SITE_STEP_MINUTES.
    stepMinutes: Number.isFinite(siteStep) && siteStep > 0 ? siteStep : DEFAULT_SITE_STEP_MINUTES,
    // Порядок категорий на сайте, заданный администратором строкой через «|».
    categoryOrder: String(raw.categoryOrder || '')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

// Стилисты и визажисты принимают раньше обычного открытия салона — та же
// проверка, что и в админке (isEarlyEligible).
function isEarlyEligible(spec) {
  return /стилист|визажист/i.test(String(spec || ''));
}

// Активные мастера. Телефон и процент мастера наружу не отдаём — на публичной
// странице этим данным делать нечего.
async function loadMasters(client) {
  const res = await client.query(
    `SELECT id, name, spec, sort_order AS "sortOrder", coalesce(photo_url, '') AS "photoUrl"
       FROM masters
      WHERE active IS TRUE
      ORDER BY sort_order, spec, name`
  );
  return res.rows.map((m) => ({
    id: m.id,
    name: m.name || '',
    spec: m.spec || '',
    photoUrl: m.photoUrl || '',
    early: isEarlyEligible(m.spec),
  }));
}

// Услуги для сайта. Скрытые (hidden) не отдаются вообще: администратор
// пометил их как устаревшие, и на публичной странице им делать нечего — при
// этом в истории записей и в отчётах они остаются целыми.
async function loadServices(client) {
  const res = await client.query(
    `SELECT id, name, category, duration, price,
            coalesce(parent_id, '')   AS "parentId",
            price_max                 AS "priceMax",
            coalesce(description, '') AS description
       FROM services
      WHERE coalesce(hidden, false) = false
      ORDER BY category, name`
  );
  return res.rows.map((s) => ({
    id: s.id,
    name: s.name || '',
    category: s.category || '',
    duration: Math.max(5, parseInt(s.duration, 10) || DEFAULT_SETTINGS.stepMinutes),
    price: Number(s.price) || 0,
    parentId: s.parentId || '',
    // Верхняя граница «вилки». null означает фиксированную цену — сайт покажет
    // одно число, а не «0 ₽».
    priceMax: s.priceMax === null ? null : Number(s.priceMax),
    description: s.description || '',
  }));
}

// Услуга, на которую можно записаться. Услуга с вариантами — это заголовок:
// у неё нет собственной цены и длительности, применимых к записи, поэтому в
// выборе она не участвует. Та же логика продублирована в админке.
function isBookable(service, allServices) {
  if (service.parentId) return true;
  return !allServices.some((x) => x.parentId === service.id);
}

// За один визит клиент может взять несколько услуг подряд — особенно в
// эпиляции, где зон под три десятка. Больше десяти за визит не бывает; предел
// нужен, чтобы подделанный запрос не заставил сервер собирать визит на весь
// рабочий день.
const MAX_SERVICES_PER_BOOKING = 10;

// Разбирает список услуг из запроса. Принимает и новый параметр serviceIds
// (несколько через запятую или массивом), и прежний одиночный serviceId —
// страница, закэшированная браузером до обновления, продолжит работать.
function parseServiceIds(raw, legacy) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) list = raw.split(',');
  else if (legacy) list = [legacy];

  const out = [];
  list.forEach((x) => {
    const id = clean(x, 32);
    if (id && out.indexOf(id) === -1) out.push(id);
  });
  return out;
}

// Проверяет выбранные услуги и считает итог визита. Все проверки — на сервере:
// цену и длительность, пришедшие из браузера, мы не используем нигде, иначе
// подделанный запрос назначил бы себе любую цену.
function resolveSelection(serviceIds, services, masterServices, masterId) {
  if (!serviceIds.length) fail('Выберите услугу', 400, 'bad_request', 'serviceId');
  if (serviceIds.length > MAX_SERVICES_PER_BOOKING) {
    fail(`За один визит можно выбрать не больше ${MAX_SERVICES_PER_BOOKING} услуг`, 400, 'too_many_services', 'serviceId');
  }

  const chosen = [];
  serviceIds.forEach((id) => {
    const s = services.find((x) => x.id === id);
    if (!s) fail('Услуга не найдена', 404, 'service_not_found', 'serviceId');
    // Услуга-заголовок сама не бронируется: цена и длительность визита должны
    // быть однозначны.
    if (!isBookable(s, services)) {
      fail(`«${s.name}» — это группа услуг, выберите конкретный вариант`, 400, 'service_is_group', 'serviceId');
    }
    if (!masterDoesService(masterServices, masterId, id)) {
      fail(`Этот мастер не оказывает услугу «${s.name}»`, 400, 'service_not_offered', 'serviceId');
    }
    chosen.push(s);
  });

  return {
    services: chosen,
    duration: chosen.reduce((sum, s) => sum + s.duration, 0),
    price: chosen.reduce((sum, s) => sum + s.price, 0),
    names: chosen.map((s) => s.name),
  };
}

// Порядок категорий на сайте задаётся в настройках строкой через «|».
// Категории, которых в списке нет, идут после перечисленных по алфавиту.
function categoryOrderIndex(order, category) {
  const i = order.indexOf(category);
  return i === -1 ? order.length : i;
}

// Связка «мастер → его услуги». Мастер, для которого администратор ещё ничего
// не настроил, в этой таблице отсутствует — и это осознанное поведение: такому
// мастеру показываем ВСЕ услуги (точно так же, как это делает админка).
async function loadMasterServices(client) {
  const res = await client.query('SELECT master_id AS "masterId", service_id AS "serviceId" FROM master_services');
  const map = {};
  res.rows.forEach((r) => {
    (map[r.masterId] = map[r.masterId] || []).push(r.serviceId);
  });
  return map;
}

// Выходные мастера на ближайший горизонт записи. Хранятся именно выходные:
// мастера, которого нет в таблице, считаем работающим каждый день — это
// поведение по умолчанию, чтобы никто не пропал с сайта до того, как
// администратор заполнит график.
async function loadDaysOff(client, masterId) {
  const res = await client.query(
    'SELECT date FROM master_days_off WHERE master_id = $1 AND date >= $2',
    [masterId, salonNow().date]
  );
  return res.rows.map((r) => r.date);
}

// То же самое сразу по всем мастерам — для страницы, которая рисует календарь
// и должна знать, какие дни у кого закрыты, ещё до выбора времени.
async function loadAllDaysOff(client) {
  const res = await client.query(
    'SELECT master_id AS "masterId", date FROM master_days_off WHERE date >= $1',
    [salonNow().date]
  );
  const map = {};
  res.rows.forEach((r) => {
    (map[r.masterId] = map[r.masterId] || []).push(r.date);
  });
  return map;
}

function masterDoesService(masterServices, masterId, serviceId) {
  const list = masterServices[masterId];
  if (!list || !list.length) return true; // список не настроен → мастер делает всё
  return list.indexOf(serviceId) !== -1;
}

// -----------------------------------------------------------------------------
//  Расчёт свободного времени
// -----------------------------------------------------------------------------
//  Одна и та же функция используется и для показа сетки времени клиенту, и для
//  повторной проверки в момент сохранения записи. Это принципиально: клиенту
//  верить нельзя, поэтому выбранное им время обязано ещё раз оказаться в этом
//  списке уже на сервере, внутри транзакции.

async function loadBusyIntervals(client, masterId, date) {
  const res = await client.query(
    `SELECT time, duration, status
       FROM appointments
      WHERE master_id = $1 AND date = $2`,
    [masterId, date]
  );
  return res.rows
    .filter((r) => !NON_CONFLICTING_STATUSES.has(String(r.status || '').trim()))
    .map((r) => {
      const start = timeToMin(r.time);
      const dur = Math.max(5, parseInt(r.duration, 10) || DEFAULT_SETTINGS.stepMinutes);
      return { start, end: start + dur };
    });
}

/**
 * Возвращает список свободных стартов ('HH:MM') для мастера на дату.
 *
 * @param {object}  args.settings      настройки салона (loadSettings)
 * @param {object}  args.master        мастер (loadMasters)
 * @param {number}  args.durationMin   длительность выбранной услуги, минуты
 * @param {string}  args.date          'YYYY-MM-DD'
 * @param {Array}   args.busy          занятые интервалы (loadBusyIntervals)
 */
function computeFreeSlots(args) {
  const { settings, master, durationMin, date, busy, daysOff } = args;

  const now = salonNow();
  const dayShift = daysBetween(now.date, date);
  if (dayShift < 0 || dayShift > CONFIG.horizonDays) return [];

  // В выходной мастера свободного времени нет вообще.
  if (Array.isArray(daysOff) && daysOff.indexOf(date) !== -1) return [];

  // Стилист/визажист может начать раньше обычного открытия салона.
  const openMin = timeToMin(master.early ? settings.earlyOpenTime : settings.openTime);
  const closeMin = timeToMin(settings.closeTime);
  const step = settings.stepMinutes;

  // Для сегодняшнего дня отсекаем прошедшее время и ближайшие leadMinutes.
  const earliestToday = dayShift === 0 ? now.minutes + CONFIG.leadMinutes : -Infinity;

  const slots = [];
  for (let t = openMin; t + durationMin <= closeMin; t += step) {
    if (t < earliestToday) continue;
    const overlaps = busy.some((b) => t < b.end && t + durationMin > b.start);
    if (!overlaps) slots.push(minToTime(t));
  }
  return slots;
}

// -----------------------------------------------------------------------------
//  Разное
// -----------------------------------------------------------------------------

// IP клиента не храним в открытом виде — только необратимый отпечаток, чтобы
// можно было опознать источник спама, не собирая персональные данные.
function hashIp(event) {
  const headers = event.headers || {};
  const ip =
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    '';
  if (!ip) return '';
  const salt = process.env.IP_HASH_SALT || 'pilka-studio-booking';
  return crypto.createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 40);
}

// Убираем управляющие символы и переводы строк, схлопываем пробелы и режем по
// длине — чтобы в базу не попало ничего, что сломает вывод в админке.
function clean(str, maxLen) {
  return String(str == null ? '' : str)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// То же самое, но с сохранением абзацев — для необязательного комментария клиента.
function cleanMultiline(str, maxLen) {
  return String(str == null ? '' : str)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen);
}

module.exports = {
  ApiError,
  CONFIG,
  DEFAULT_SETTINGS,
  NON_CONFLICTING_STATUSES,
  WEB_BOOKING_STATUS,
  WEB_BOOKING_SOURCE,
  WEB_BOOKING_AUTHOR,
  clean,
  cleanMultiline,
  computeFreeSlots,
  connect,
  corsHeaders,
  daysBetween,
  fail,
  hashIp,
  isEarlyEligible,
  isBookable,
  parseServiceIds,
  resolveSelection,
  MAX_SERVICES_PER_BOOKING,
  categoryOrderIndex,
  isValidDateStr,
  isValidTimeStr,
  jsonResponse,
  loadAllDaysOff,
  loadBusyIntervals,
  loadDaysOff,
  loadMasters,
  loadMasterServices,
  loadServices,
  loadSettings,
  masterDoesService,
  minToTime,
  normalizePhone,
  phoneKey,
  salonNow,
  timeToMin,
  uid,
  withDb,
};
