// =============================================================================
//  POST /api/book
// =============================================================================
//  Принимает заполненную форму записи, проверяет её целиком заново на сервере и
//  создаёт запись в боевой таблице appointments со статусом «Не подтверждён».
//
//  Что здесь важно понимать:
//
//  1. Данным из браузера не верим ни в чём. Время, выбранное клиентом, ещё раз
//     проверяется тем же расчётом свободных слотов, что и на шаге показа сетки.
//     Цена и длительность берутся из таблицы services, а не из запроса.
//
//  2. Двое клиентов могут нажать «Записаться» на одно и то же время в одну и ту
//     же секунду. Чтобы второй не «пролез», вся проверка и вставка идут внутри
//     одной транзакции под advisory-блокировкой по паре (мастер, дата): второй
//     запрос дождётся первого, пересчитает занятость уже с учётом новой записи и
//     получит понятный отказ «это время только что заняли».
//
//  3. Запись создаётся сразу в appointments (а не в отдельной таблице заявок),
//     потому что статус «Не подтверждён» занимает слот. Иначе одно и то же время
//     можно было бы продать дважды — с сайта и из админки.
//
//  4. Карточка клиента ищется по последним 10 цифрам номера, а не по точному
//     совпадению строки. Иначе «+7 940…» с сайта создавал бы дубль карточки
//     рядом с «8 940…», записанной администратором вручную.
// =============================================================================

const {
  CONFIG,
  WEB_BOOKING_AUTHOR,
  WEB_BOOKING_SOURCE,
  WEB_BOOKING_STATUS,
  clean,
  cleanMultiline,
  computeFreeSlots,
  daysBetween,
  fail,
  isBookable,
  hashIp,
  isValidDateStr,
  isValidTimeStr,
  loadBusyIntervals,
  loadDaysOff,
  loadMasters,
  loadMasterServices,
  loadServices,
  loadSettings,
  masterDoesService,
  normalizePhone,
  phoneKey,
  salonNow,
  uid,
  withDb,
} = require('./lib/core.js');

// Минимальное время заполнения формы. Живой человек не успевает выбрать услугу,
// мастера, дату, время и напечатать имя с телефоном за пару секунд — а бот успевает.
const MIN_FILL_SECONDS = 4;

function parseBody(event) {
  if (!event.body) fail('Пустой запрос');
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > 8000) fail('Слишком большой запрос');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Некорректный формат запроса');
    return parsed;
  } catch (e) {
    if (e && e.code) throw e;
    return fail('Некорректный формат запроса');
  }
}

exports.handler = withDb(
  async function (event, client) {
    const body = parseBody(event);

    // ---------------------------------------------------------------------
    //  Антиспам, который не требует обращения к базе
    // ---------------------------------------------------------------------

    // Honeypot: поле спрятано от людей средствами CSS и всегда должно быть
    // пустым. Боты, заполняющие все поля подряд, выдают себя именно здесь.
    if (clean(body.website, 100)) {
      // Отвечаем как при обычной ошибке, не подсказывая настоящую причину.
      fail('Не удалось отправить заявку. Обновите страницу и попробуйте ещё раз.', 400, 'rejected');
    }

    const elapsed = Number(body.elapsedSeconds);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_SECONDS) {
      fail('Не удалось отправить заявку. Обновите страницу и попробуйте ещё раз.', 400, 'rejected');
    }

    // ---------------------------------------------------------------------
    //  Разбор и проверка полей
    // ---------------------------------------------------------------------

    const masterId = clean(body.masterId, 32);
    const serviceId = clean(body.serviceId, 32);
    const date = clean(body.date, 10);
    const time = clean(body.time, 5);
    const clientName = clean(body.name, 80);
    const phoneRaw = clean(body.phone, 40);
    const comment = cleanMultiline(body.comment, 500);
    const consent = body.consent === true || body.consent === 'true' || body.consent === 1;

    if (!consent) {
      fail('Нужно согласие на обработку персональных данных', 400, 'no_consent', 'consent');
    }
    if (clientName.length < 2) {
      fail('Укажите имя — как к вам обращаться', 400, 'bad_name', 'name');
    }
    if (!/\p{L}/u.test(clientName)) {
      fail('Имя должно содержать буквы', 400, 'bad_name', 'name');
    }

    const phoneCheck = normalizePhone(phoneRaw);
    if (!phoneCheck.ok) fail(phoneCheck.reason, 400, 'bad_phone', 'phone');
    const phone = phoneCheck.phone;

    if (!masterId) fail('Выберите мастера', 400, 'bad_request', 'masterId');
    if (!serviceId) fail('Выберите услугу', 400, 'bad_request', 'serviceId');
    if (!isValidDateStr(date)) fail('Выберите дату записи', 400, 'bad_date', 'date');
    if (!isValidTimeStr(time)) fail('Выберите время записи', 400, 'bad_time', 'time');

    const now = salonNow();
    const shift = daysBetween(now.date, date);
    if (shift < 0) fail('Эта дата уже прошла — выберите другую', 400, 'date_past', 'date');
    if (shift > CONFIG.horizonDays) {
      fail(`Запись открыта на ${CONFIG.horizonDays} дней вперёд`, 400, 'date_far', 'date');
    }

    // ---------------------------------------------------------------------
    //  Справочники и сверка выбора
    // ---------------------------------------------------------------------

    const [settings, masters, services, masterServices] = await Promise.all([
      loadSettings(client),
      loadMasters(client),
      loadServices(client),
      loadMasterServices(client),
    ]);

    const master = masters.find((m) => m.id === masterId);
    if (!master) fail('Мастер не найден или сейчас не принимает', 404, 'master_not_found', 'masterId');

    const service = services.find((s) => s.id === serviceId);
    if (!service) fail('Услуга не найдена', 404, 'service_not_found', 'serviceId');

    // Услуга-заголовок (у неё есть варианты) сама не бронируется: цена и
    // длительность записи должны быть однозначны.
    if (!isBookable(service, services)) {
      fail('Выберите конкретный вариант этой услуги', 400, 'service_is_group', 'serviceId');
    }

    if (!masterDoesService(masterServices, masterId, serviceId)) {
      fail('Этот мастер не оказывает выбранную услугу', 400, 'service_not_offered', 'serviceId');
    }

    // Длительность и цену берём из справочника, а не из запроса, — клиент не
    // должен иметь возможности повлиять ни на то, ни на другое.
    const duration = service.duration;
    const price = service.price;

    const ipHash = hashIp(event);
    const userAgent = clean(event.headers && (event.headers['user-agent'] || event.headers['User-Agent']), 240);
    const pKey = phoneKey(phone);

    // ---------------------------------------------------------------------
    //  Транзакция: блокировка → проверка занятости → вставка
    // ---------------------------------------------------------------------

    await client.query('BEGIN');
    try {
      // Блокировка по паре (мастер, дата). Держится до конца транзакции и
      // сериализует одновременные попытки записаться к одному мастеру на один
      // день. Записи к другим мастерам и на другие даты не задерживаются.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pilka:${masterId}:${date}`]);

      // -- Антиспам по номеру телефона -----------------------------------
      const dayCountRes = await client.query(
        `SELECT count(*)::int AS n
           FROM web_bookings
          WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1
            AND created_at > now() - interval '24 hours'`,
        ['%' + pKey]
      );
      if ((dayCountRes.rows[0] || {}).n >= CONFIG.maxPerPhonePerDay) {
        fail(
          'С этого номера уже отправлено несколько заявок за сегодня. Позвоните нам, пожалуйста — мы поможем.',
          429,
          'rate_limited',
          'phone'
        );
      }

      const activeRes = await client.query(
        `SELECT count(*)::int AS n
           FROM appointments
          WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1
            AND date >= $2
            AND status NOT IN ('Отменён клиентом', 'Отменён салоном', 'Не пришёл')`,
        ['%' + pKey, now.date]
      );
      if ((activeRes.rows[0] || {}).n >= CONFIG.maxActiveFuture) {
        fail(
          'На этот номер уже оформлено несколько предстоящих записей. Позвоните нам, чтобы добавить ещё одну.',
          429,
          'too_many_active',
          'phone'
        );
      }

      // -- Проверка, что выбранное время действительно свободно -----------
      // Выходные читаем внутри транзакции: администратор мог закрыть день,
      // пока клиент заполнял форму.
      const busy = await loadBusyIntervals(client, masterId, date);
      const daysOff = await loadDaysOff(client, masterId);
      if (daysOff.indexOf(date) !== -1) {
        fail('В этот день мастер не работает. Пожалуйста, выберите другую дату.', 409, 'day_off', 'date');
      }
      const freeSlots = computeFreeSlots({ settings, master, durationMin: duration, date, busy, daysOff });

      if (freeSlots.indexOf(time) === -1) {
        // Разделяем два разных случая, чтобы подсказка была честной.
        const startMin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
        const taken = busy.some((b) => startMin < b.end && startMin + duration > b.start);
        if (taken) {
          fail(
            'Это время только что заняли. Пожалуйста, выберите другое — сетка уже обновлена.',
            409,
            'slot_taken',
            'time'
          );
        }
        fail('Это время недоступно для записи. Выберите другое, пожалуйста.', 409, 'slot_unavailable', 'time');
      }

      // -- Карточка клиента ------------------------------------------------
      // Ищем по последним 10 цифрам, чтобы не плодить дубли рядом с номерами,
      // которые администраторы вводили вручную в произвольном формате.
      let clientId = null;
      if (pKey) {
        const existing = await client.query(
          `SELECT id, name FROM clients
            WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1
            ORDER BY updated_at DESC
            LIMIT 1`,
          ['%' + pKey]
        );
        if (existing.rows.length) {
          clientId = existing.rows[0].id;
          // Имя в существующей карточке не перезаписываем: там может быть
          // уточнённое администратором написание, а с сайта приходит то, что
          // клиент набрал на телефоне.
        } else {
          clientId = uid('c');
          await client.query(
            'INSERT INTO clients (id, name, phone, consent) VALUES ($1, $2, $3, $4)',
            [clientId, clientName, phone, 'Да']
          );
        }
      }

      // -- Собственно запись ------------------------------------------------
      const apptId = uid('a');
      const notes = comment ? `Заявка с сайта: ${comment}` : 'Заявка с сайта';

      await client.query(
        `INSERT INTO appointments
           (id, date, time, duration, master_id, client_name, phone, service_id,
            price, prepay, status, reminder_sent, source, notes, created_at,
            created_by, payment_method, rate_override)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          apptId,
          date,
          time,
          duration,
          masterId,
          clientName,
          phone,
          serviceId,
          price,
          0,
          WEB_BOOKING_STATUS,
          'Нет',
          WEB_BOOKING_SOURCE,
          notes,
          Date.now(),
          WEB_BOOKING_AUTHOR,
          'Наличными',
          null,
        ]
      );

      // -- Журнал заявок с сайта ---------------------------------------------
      await client.query(
        `INSERT INTO web_bookings
           (id, appointment_id, master_id, service_id, date, time, duration,
            client_name, phone, phone_raw, comment, consent, status, ip_hash, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          uid('w'),
          apptId,
          masterId,
          serviceId,
          date,
          time,
          duration,
          clientName,
          phone,
          phoneRaw,
          comment,
          true,
          'Новая',
          ipHash,
          userAgent,
        ]
      );

      await client.query('COMMIT');

      return {
        booking: {
          date,
          time,
          duration,
          masterName: master.name,
          serviceName: service.name,
          price,
          clientName,
          phone,
        },
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* соединение могло уже отвалиться — откат тогда произойдёт сам */
      }
      throw err;
    }
  },
  { method: 'POST' }
);
